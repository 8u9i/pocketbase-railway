// pocketbase-railway - a custom PocketBase build with vector search baked in.
//
// PocketBase normally ships with the pure-Go modernc.org/sqlite driver. That
// driver has no SQLite extension loading, so "extensions like pgvector" are
// impossible on the stock binary. This build swaps in the ncruces/go-sqlite3
// driver (also pure Go, CGO-free) and registers SQLite's vec1 vector search
// extension on every connection - the SQLite equivalent of pgvector.
//
//	vec1 virtual tables  ->  pgvector "vector" columns + ANN indexes
//	vec1_from_json()     ->  insert/query vectors
//	vec1_l2_distance()   ->  pgvector <-> distance operators
//	vec_items(:q, '{k:N}') -> pgvector ORDER BY embedding <-> query (KNN)
//
// Additional features beyond stock PocketBase:
//   - FTS5 full-text search (/api/search/*)
//   - Soft delete with trash/restore (/api/restore/*, /api/trash/*, /api/purge/*)
//   - Declarative webhook engine (/api/webhooks/*)
//   - Anonymous auth (/api/auth/anonymous)
//   - CSV/JSON bulk import (/api/import/*)
//
// Everything stays in this ONE binary/service: same SQLite file, same
// collections, same hooks, same migrations, same admin UI.
//
// Build (see Dockerfile):
//
//	go build -tags no_default_driver \
//	  -ldflags "-X github.com/ncruces/go-sqlite3/driver.driverName=sqlite" \
//	  -o pocketbase .

package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ncruces/go-sqlite3"
	_ "github.com/ncruces/go-sqlite3/driver" // registers driver, renamed to "sqlite" via ldflags
	"github.com/ncruces/go-sqlite3/ext/fts5" // fts5 full-text search extension
	"github.com/ncruces/go-sqlite3/ext/vec1" // vec1 vector extension (registered per-connection)
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

func init() {
	sqlite3.AutoExtension(vec1.Register)
	sqlite3.AutoExtension(fts5.Register)
}

func vecDBConnect(dbPath string) (*dbx.DB, error) {
	pragmas := "?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=journal_size_limit(200000000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)&_pragma=temp_store(MEMORY)&_pragma=cache_size(-32000)"
	dsn := "file:" + dbPath + pragmas
	return dbx.Open("sqlite", dsn)
}

func main() {
	vecEnabled := true
	dbConnect := vecDBConnect
	if strings.TrimSpace(os.Getenv("PB_VEC_DISABLED")) == "1" {
		vecEnabled = false
		dbConnect = core.DefaultDBConnect
	}

	app := pocketbase.NewWithConfig(pocketbase.Config{
		DBConnect: dbConnect,
	})

	jsvm.MustRegister(app, jsvm.Config{
		HooksWatch: true,
	})

	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		registerVecRoutes(se)
		registerSearchRoutes(se)
		registerSoftDeleteRoutes(se)
		registerWebhookRoutes(se)
		registerAnonymousAuthRoutes(se)
		registerImportRoutes(se)

		if err := se.Next(); err != nil {
			return err
		}

		if vecEnabled {
			log.Println("==> vec1 vector search enabled")
		} else {
			log.Println("==> PB_VEC_DISABLED=1: using stock SQLite driver")
		}

		return nil
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}

// ---------------------------------------------------------------------------
// Vector search routes (/api/vec/*)
// ---------------------------------------------------------------------------

func registerVecRoutes(se *core.ServeEvent) {
	se.Router.GET("/api/vec/health", func(e *core.RequestEvent) error {
		enabled := false
		var n sql.NullFloat64
		if err := e.App.DB().NewQuery("SELECT vec1_config('nthread')").Row(&n); err == nil && n.Valid {
			enabled = true
		}
		return e.JSON(http.StatusOK, map[string]any{"enabled": enabled})
	})

	se.Router.POST("/api/vec/insert", func(e *core.RequestEvent) error {
		var body struct {
			Vector string `json:"vector"`
		}
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("Invalid JSON: "+err.Error(), nil)
		}
		if body.Vector == "" {
			return e.BadRequestError("Missing field: vector", nil)
		}
		if !vecRe.MatchString(body.Vector) {
			return e.BadRequestError("vector must be a float array, e.g. [1, 2, 3]", nil)
		}

		_, err := e.App.DB().NewQuery(
			"INSERT INTO vec_items(vector) VALUES (vec1_from_json({:vec}))",
		).Bind(dbx.Params{"vec": body.Vector}).Execute()
		if err != nil {
			return e.BadRequestError("Insert failed: "+err.Error(), nil)
		}

		var rowID int64
		_ = e.App.DB().NewQuery("SELECT MAX(rowid) FROM vec_items").Row(&rowID)
		return e.JSON(http.StatusOK, map[string]any{"rowid": rowID})
	})

	se.Router.POST("/api/vec/document", func(e *core.RequestEvent) error {
		var body struct {
			ID         string `json:"id"`
			Title      string `json:"title"`
			Content    string `json:"content"`
			ChunkIndex int64  `json:"chunk_index"`
			VectorID   int64  `json:"vector_id"`
			DocID      string `json:"doc_id"`
			TokenCount int64  `json:"token_count"`
		}
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("Invalid JSON: "+err.Error(), nil)
		}

		_, err := e.App.DB().NewQuery(
			"INSERT INTO rag_documents (id, title, content, chunk_index, vector_id, doc_id, token_count) "+
				"VALUES ({:id}, {:title}, {:content}, {:chunk_index}, {:vector_id}, {:doc_id}, {:token_count})",
		).Bind(dbx.Params{
			"id":          body.ID,
			"title":       body.Title,
			"content":     body.Content,
			"chunk_index": body.ChunkIndex,
			"vector_id":   body.VectorID,
			"doc_id":      body.DocID,
			"token_count": body.TokenCount,
		}).Execute()
		if err != nil {
			return e.BadRequestError("Insert failed: "+err.Error(), nil)
		}
		return e.JSON(http.StatusOK, map[string]any{"success": true})
	})

	se.Router.GET("/api/vec/documents", func(e *core.RequestEvent) error {
		rowids := e.Request.URL.Query().Get("rowids")
		if rowids == "" {
			return e.BadRequestError("Missing query param: rowids (comma-separated)", nil)
		}

		type doc struct {
			ID       string `db:"id"`
			Title    string `db:"title"`
			Content  string `db:"content"`
			DocID    string `db:"doc_id"`
			VectorID int64  `db:"vector_id"`
		}
		docs := []doc{}

		idList := strings.Split(rowids, ",")
		placeholders := make([]string, len(idList))
		params := dbx.Params{}
		for i, id := range idList {
			placeholders[i] = fmt.Sprintf("{:id%d}", i)
			params[fmt.Sprintf("id%d", i)] = id
		}

		query := fmt.Sprintf(
			"SELECT id, title, content, doc_id, vector_id FROM rag_documents WHERE vector_id IN (%s)",
			strings.Join(placeholders, ","),
		)

		if err := e.App.DB().NewQuery(query).Bind(params).All(&docs); err != nil {
			return e.BadRequestError("Fetch failed: "+err.Error(), nil)
		}
		return e.JSON(http.StatusOK, map[string]any{"documents": docs})
	})

	se.Router.GET("/api/vec/search", func(e *core.RequestEvent) error {
		vec := e.Request.URL.Query().Get("vector")
		if vec == "" {
			return e.BadRequestError("Missing query param: vector", nil)
		}
		if !vecRe.MatchString(vec) {
			return e.BadRequestError("vector must be a float array, e.g. [1, 2, 3]", nil)
		}
		limit, _ := strconv.Atoi(e.Request.URL.Query().Get("limit"))
		if limit <= 0 || limit > 100 {
			limit = 5
		}

		type result struct {
			RowID    int64   `db:"rowid"`
			Distance float64 `db:"distance"`
		}
		results := []result{}
		err := e.App.DB().NewQuery(
			"SELECT rowid, CAST(distance AS REAL) AS distance "+
				"FROM vec_items(vec1_from_json({:vec}), {:limit}) LIMIT {:limit}",
		).Bind(dbx.Params{"vec": vec, "limit": limit}).All(&results)
		if err != nil {
			return e.BadRequestError("Search failed: "+err.Error(), nil)
		}
		return e.JSON(http.StatusOK, map[string]any{"results": results})
	})
}

// ---------------------------------------------------------------------------
// FTS5 full-text search routes (/api/search/*)
// ---------------------------------------------------------------------------

func registerSearchRoutes(se *core.ServeEvent) {
	se.Router.GET("/api/search/health", func(e *core.RequestEvent) error {
		enabled := false
		var result sql.NullString
		if err := e.App.DB().NewQuery("SELECT fts5('test')").Row(&result); err == nil {
			enabled = true
		}
		return e.JSON(http.StatusOK, map[string]any{"enabled": enabled})
	})

	se.Router.GET("/api/search", func(e *core.RequestEvent) error {
		query := e.Request.URL.Query().Get("q")
		if query == "" {
			return e.BadRequestError("Missing query param: q", nil)
		}

		collection := e.Request.URL.Query().Get("collection")
		limit, _ := strconv.Atoi(e.Request.URL.Query().Get("limit"))
		if limit <= 0 || limit > 100 {
			limit = 20
		}

		sqlQuery := `
			SELECT collection, record_id,
				highlight(fts_records, 2, '<mark>', '</mark>') as title_snippet,
				snippet(fts_records, 3, '<mark>', '</mark>', '...', 32) as content_snippet,
				bm25(fts_records, 10.0, 1.0, 0.5) as rank
			FROM fts_records
			WHERE fts_records MATCH {:query}
		`
		params := dbx.Params{"query": query}

		if collection != "" {
			sqlQuery += " AND collection = {:collection}"
			params["collection"] = collection
		}

		sqlQuery += " ORDER BY rank LIMIT {:limit}"
		params["limit"] = limit

		type result struct {
			Collection     string  `db:"collection"`
			RecordID       string  `db:"record_id"`
			TitleSnippet   string  `db:"title_snippet"`
			ContentSnippet string  `db:"content_snippet"`
			Rank           float64 `db:"rank"`
		}
		results := []result{}

		if err := e.App.DB().NewQuery(sqlQuery).Bind(params).All(&results); err != nil {
			return e.BadRequestError("Search failed: "+err.Error(), nil)
		}

		return e.JSON(http.StatusOK, map[string]any{
			"query":   query,
			"results": results,
			"count":   len(results),
		})
	})

	se.Router.POST("/api/search/reindex", func(e *core.RequestEvent) error {
		var body struct {
			Collection string   `json:"collection"`
			Fields     []string `json:"fields"`
		}
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("Invalid JSON: "+err.Error(), nil)
		}
		if body.Collection == "" {
			return e.BadRequestError("Missing field: collection", nil)
		}

		collection, err := e.App.FindCollectionByNameOrId(body.Collection)
		if err != nil {
			return e.BadRequestError("Collection not found: "+body.Collection, nil)
		}

		fields := body.Fields
		if len(fields) == 0 {
			for _, f := range collection.Fields {
				if f.Type() == "text" || f.Type() == "editor" {
					fields = append(fields, f.GetName())
				}
			}
		}

		// Clear existing index for this collection
		_, _ = e.App.DB().NewQuery(
			"DELETE FROM fts_records WHERE collection = {:col}",
		).Bind(dbx.Params{"col": body.Collection}).Execute()

		return e.JSON(http.StatusOK, map[string]any{
			"collection": body.Collection,
			"fields":     fields,
			"message":    "Index cleared. Records will be re-indexed via hooks.",
		})
	})
}

// ---------------------------------------------------------------------------
// Soft delete routes (/api/restore/*, /api/trash/*, /api/purge/*)
// ---------------------------------------------------------------------------

func registerSoftDeleteRoutes(se *core.ServeEvent) {
	se.Router.POST("/api/restore/{collection}/{id}", func(e *core.RequestEvent) error {
		collection := e.Request.PathValue("collection")
		id := e.Request.PathValue("id")

		_, err := e.App.DB().NewQuery(
			"UPDATE {:collection} SET deleted_at = '' WHERE id = {:id}",
		).Bind(dbx.Params{"collection": collection, "id": id}).Execute()
		if err != nil {
			return e.BadRequestError("Restore failed: "+err.Error(), nil)
		}

		return e.JSON(http.StatusOK, map[string]any{
			"restored":   true,
			"collection": collection,
			"id":         id,
		})
	})

	se.Router.GET("/api/trash/{collection}", func(e *core.RequestEvent) error {
		collection := e.Request.PathValue("collection")
		limit, _ := strconv.Atoi(e.Request.URL.Query().Get("limit"))
		if limit <= 0 || limit > 100 {
			limit = 50
		}
		page, _ := strconv.Atoi(e.Request.URL.Query().Get("page"))
		if page < 1 {
			page = 1
		}
		offset := (page - 1) * limit

		type trashItem struct {
			ID        string `db:"id"`
			Created   string `db:"created"`
			Updated   string `db:"updated"`
			DeletedAt string `db:"deleted_at"`
		}
		items := []trashItem{}

		err := e.App.DB().NewQuery(
			"SELECT id, created, updated, deleted_at FROM {:collection} WHERE deleted_at != '' ORDER BY deleted_at DESC LIMIT {:limit} OFFSET {:offset}",
		).Bind(dbx.Params{"collection": collection, "limit": limit, "offset": offset}).All(&items)
		if err != nil {
			return e.BadRequestError("Failed to list trash: "+err.Error(), nil)
		}

		return e.JSON(http.StatusOK, map[string]any{
			"collection": collection,
			"items":      items,
			"page":       page,
			"limit":      limit,
		})
	})

	se.Router.DELETE("/api/purge/{collection}/{id}", func(e *core.RequestEvent) error {
		collection := e.Request.PathValue("collection")
		id := e.Request.PathValue("id")

		_, err := e.App.DB().NewQuery(
			"DELETE FROM {:collection} WHERE id = {:id}",
		).Bind(dbx.Params{"collection": collection, "id": id}).Execute()
		if err != nil {
			return e.BadRequestError("Purge failed: "+err.Error(), nil)
		}

		// Also remove from FTS index
		_, _ = e.App.DB().NewQuery(
			"DELETE FROM fts_records WHERE collection = {:col} AND record_id = {:id}",
		).Bind(dbx.Params{"col": collection, "id": id}).Execute()

		return e.JSON(http.StatusOK, map[string]any{
			"purged":     true,
			"collection": collection,
			"id":         id,
		})
	})
}

// ---------------------------------------------------------------------------
// Webhook management routes (/api/webhooks/*)
// ---------------------------------------------------------------------------

func registerWebhookRoutes(se *core.ServeEvent) {
	se.Router.POST("/api/webhooks/test", func(e *core.RequestEvent) error {
		var body struct {
			URL     string `json:"url"`
			Secret  string `json:"secret"`
			Payload any    `json:"payload"`
		}
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("Invalid JSON: "+err.Error(), nil)
		}
		if body.URL == "" {
			return e.BadRequestError("Missing field: url", nil)
		}

		payload := body.Payload
		if payload == nil {
			payload = map[string]any{"test": true, "timestamp": time.Now().Format(time.RFC3339)}
		}

		payloadBytes, _ := json.Marshal(payload)

		headers := map[string]string{
			"Content-Type":       "application/json",
			"X-PB-Webhook-Event": "test",
			"X-PB-Webhook-ID":    "test",
			"X-PB-Delivery-ID":   "test-" + strconv.FormatInt(time.Now().Unix(), 10),
		}
		if body.Secret != "" {
			mac := hmac.New(sha256.New, []byte(body.Secret))
			mac.Write(payloadBytes)
			headers["X-PB-Signature"] = "sha256=" + hex.EncodeToString(mac.Sum(nil))
		}

		client := &http.Client{Timeout: 30 * time.Second}
		req, err := http.NewRequest("POST", body.URL, strings.NewReader(string(payloadBytes)))
		if err != nil {
			return e.BadRequestError("Request creation failed: "+err.Error(), nil)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}

		resp, err := client.Do(req)
		if err != nil {
			return e.JSON(http.StatusOK, map[string]any{
				"success": false,
				"error":   err.Error(),
			})
		}
		defer resp.Body.Close()

		respBody, _ := io.ReadAll(resp.Body)

		return e.JSON(http.StatusOK, map[string]any{
			"success":      resp.StatusCode >= 200 && resp.StatusCode < 300,
			"status_code":  resp.StatusCode,
			"response_body": string(respBody),
		})
	})

	se.Router.GET("/api/webhooks/deliveries", func(e *core.RequestEvent) error {
		webhookID := e.Request.URL.Query().Get("webhook_id")
		limit, _ := strconv.Atoi(e.Request.URL.Query().Get("limit"))
		if limit <= 0 || limit > 100 {
			limit = 50
		}

		sqlQuery := "SELECT * FROM webhook_deliveries"
		params := dbx.Params{}

		if webhookID != "" {
			sqlQuery += " WHERE webhook_id = {:webhook_id}"
			params["webhook_id"] = webhookID
		}

		sqlQuery += " ORDER BY created DESC LIMIT {:limit}"
		params["limit"] = limit

		type delivery struct {
			ID          string `db:"id"`
			WebhookID   string `db:"webhook_id"`
			Event       string `db:"event"`
			StatusCode  int    `db:"status_code"`
			Success     bool   `db:"success"`
			Attempts    int    `db:"attempts"`
			NextRetryAt string `db:"next_retry_at"`
			Created     string `db:"created"`
		}
		deliveries := []delivery{}

		if err := e.App.DB().NewQuery(sqlQuery).Bind(params).All(&deliveries); err != nil {
			return e.BadRequestError("Failed to list deliveries: "+err.Error(), nil)
		}

		return e.JSON(http.StatusOK, map[string]any{
			"deliveries": deliveries,
			"count":      len(deliveries),
		})
	})
}

// ---------------------------------------------------------------------------
// Anonymous auth routes (/api/auth/anonymous)
// ---------------------------------------------------------------------------

func registerAnonymousAuthRoutes(se *core.ServeEvent) {
	se.Router.POST("/api/auth/anonymous", func(e *core.RequestEvent) error {
		collections, err := e.App.FindAllCollections()
		if err != nil {
			return e.InternalServerError("Failed to find collections: "+err.Error(), nil)
		}

		var authCollection *core.Collection
		for _, c := range collections {
			if c.Type == core.CollectionTypeAuth {
				authCollection = c
				break
			}
		}

		if authCollection == nil {
			return e.BadRequestError("No auth collection found. Create one in the dashboard first.", nil)
		}

		anonID := "anon_" + generateID()
		anonEmail := anonID + "@anonymous.local"
		anonPassword := generateID() + generateID()

		record := core.NewRecord(authCollection)
		record.Set("email", anonEmail)
		record.Set("password", anonPassword)
		record.Set("passwordConfirm", anonPassword)
		record.Set("anonymous", true)
		record.Set("name", "Anonymous User")

		if err := e.App.Save(record); err != nil {
			return e.BadRequestError("Failed to create anonymous user: "+err.Error(), nil)
		}

		token, err := record.NewAuthToken()
		if err != nil {
			return e.InternalServerError("Failed to create token: "+err.Error(), nil)
		}

		return e.JSON(http.StatusOK, map[string]any{
			"token":  token,
			"record": record,
		})
	})

	se.Router.POST("/api/auth/anonymous/claim", func(e *core.RequestEvent) error {
		var body struct {
			AnonymousToken  string `json:"anonymous_token"`
			Email           string `json:"email"`
			Password        string `json:"password"`
			PasswordConfirm string `json:"password_confirm"`
		}
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("Invalid JSON: "+err.Error(), nil)
		}

		if body.Email == "" || body.Password == "" {
			return e.BadRequestError("Missing fields: email, password", nil)
		}

		collections, err := e.App.FindAllCollections()
		if err != nil {
			return e.InternalServerError("Failed to find collections: "+err.Error(), nil)
		}

		var authCollection *core.Collection
		for _, c := range collections {
			if c.Type == core.CollectionTypeAuth {
				authCollection = c
				break
			}
		}

		if authCollection == nil {
			return e.BadRequestError("No auth collection found", nil)
		}

		// Find anonymous user
		anonRecord, err := e.App.FindFirstRecordByFilter(authCollection.Id, "anonymous = true")
		if err != nil {
			return e.BadRequestError("No anonymous session found", nil)
		}

		anonRecord.Set("email", body.Email)
		anonRecord.Set("password", body.Password)
		anonRecord.Set("passwordConfirm", body.Password)
		anonRecord.Set("anonymous", false)

		if err := e.App.Save(anonRecord); err != nil {
			return e.BadRequestError("Failed to claim account: "+err.Error(), nil)
		}

		token, err := anonRecord.NewAuthToken()
		if err != nil {
			return e.InternalServerError("Failed to create token: "+err.Error(), nil)
		}

		return e.JSON(http.StatusOK, map[string]any{
			"token":   token,
			"record":  anonRecord,
			"claimed": true,
		})
	})
}

// ---------------------------------------------------------------------------
// Import routes (/api/import/*)
// ---------------------------------------------------------------------------

func registerImportRoutes(se *core.ServeEvent) {
	se.Router.POST("/api/import/csv", func(e *core.RequestEvent) error {
		collection := e.Request.URL.Query().Get("collection")
		if collection == "" {
			return e.BadRequestError("Missing query param: collection", nil)
		}

		file, _, err := e.Request.FormFile("file")
		if err != nil {
			return e.BadRequestError("Missing file upload (field: file): "+err.Error(), nil)
		}
		defer file.Close()

		reader := csv.NewReader(file)
		headers, err := reader.Read()
		if err != nil {
			return e.BadRequestError("Failed to read CSV headers: "+err.Error(), nil)
		}

		var rows [][]string
		for {
			row, err := reader.Read()
			if err == io.EOF {
				break
			}
			if err != nil {
				continue
			}
			rows = append(rows, row)
		}

		type rowResult struct {
			Row    int    `json:"row"`
			ID     string `json:"id,omitempty"`
			Status string `json:"status"`
			Error  string `json:"error,omitempty"`
		}
		var results []rowResult
		imported := 0

		coll, err := e.App.FindCollectionByNameOrId(collection)
		if err != nil {
			return e.BadRequestError("Collection not found: "+collection, nil)
		}

		for i, row := range rows {
			data := map[string]any{}
			for j, header := range headers {
				if j < len(row) {
					data[header] = row[j]
				}
			}

			record := core.NewRecord(coll)
			for k, v := range data {
				record.Set(k, v)
			}

			if err := e.App.Save(record); err != nil {
				results = append(results, rowResult{
					Row:    i + 1,
					Status: "error",
					Error:  err.Error(),
				})
			} else {
				imported++
				results = append(results, rowResult{
					Row:    i + 1,
					ID:     record.Id,
					Status: "success",
				})
			}
		}

		return e.JSON(http.StatusOK, map[string]any{
			"collection": collection,
			"total":      len(rows),
			"imported":   imported,
			"failed":     len(rows) - imported,
			"results":    results,
		})
	})

	se.Router.POST("/api/import/json", func(e *core.RequestEvent) error {
		collection := e.Request.URL.Query().Get("collection")
		if collection == "" {
			return e.BadRequestError("Missing query param: collection", nil)
		}

		var items []map[string]any
		if err := e.BindBody(&items); err != nil {
			return e.BadRequestError("Invalid JSON (expected array): "+err.Error(), nil)
		}

		type itemResult struct {
			Index  int    `json:"index"`
			ID     string `json:"id,omitempty"`
			Status string `json:"status"`
			Error  string `json:"error,omitempty"`
		}
		var results []itemResult
		imported := 0

		coll, err := e.App.FindCollectionByNameOrId(collection)
		if err != nil {
			return e.BadRequestError("Collection not found: "+collection, nil)
		}

		for i, item := range items {
			record := core.NewRecord(coll)
			for k, v := range item {
				record.Set(k, v)
			}

			if err := e.App.Save(record); err != nil {
				results = append(results, itemResult{
					Index:  i,
					Status: "error",
					Error:  err.Error(),
				})
			} else {
				imported++
				results = append(results, itemResult{
					Index:  i,
					ID:     record.Id,
					Status: "success",
				})
			}
		}

		return e.JSON(http.StatusOK, map[string]any{
			"collection": collection,
			"total":      len(items),
			"imported":   imported,
			"failed":     len(items) - imported,
			"results":    results,
		})
	})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func generateID() string {
	return fmt.Sprintf("%d%s", time.Now().UnixNano(), randomString(6))
}

func randomString(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = letters[rand.Intn(len(letters))]
	}
	return string(b)
}

var vecRe = mustRe(`^\[[\d.,\s\-+eE]+\]$`)

func mustRe(pattern string) *regexp.Regexp {
	return regexp.MustCompile(pattern)
}
