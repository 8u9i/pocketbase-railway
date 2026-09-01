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
	"database/sql"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/ncruces/go-sqlite3"
	_ "github.com/ncruces/go-sqlite3/driver" // registers driver, renamed to "sqlite" via ldflags
	"github.com/ncruces/go-sqlite3/ext/vec1" // vec1 vector extension (registered per-connection)
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

func init() {
	// Load the vec1 vector extension into every new SQLite connection.
	// vec1 is SQLite's official vector search engine (https://sqlite.org/vec1):
	// `vec1` virtual tables + KNN via table-valued function queries.
	sqlite3.AutoExtension(vec1.Register)
}

// vecDBConnect mirrors PocketBase's DefaultDBConnect (core/db_connect.go) but
// opens through the ncruces driver instead of modernc, using the
// same PRAGMAs. The ncruces driver parses "file:" URIs and applies _pragma
// params in order - busy_timeout must come first so the connection blocks on
// busy before WAL mode is set, matching modernc's documented ordering.
//
// Note: "_defensive" is a modernc-specific DSN param and is intentionally
// omitted here - the ncruces/vec1 SQLite build has defensive mode enabled by
// default.
func vecDBConnect(dbPath string) (*dbx.DB, error) {
	pragmas := "?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=journal_size_limit(200000000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)&_pragma=temp_store(MEMORY)&_pragma=cache_size(-32000)"

	dsn := "file:" + dbPath + pragmas

	db, err := dbx.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}

	return db, nil
}

func main() {
	// Log which SQLite runtime is active so deployments are easy to audit.
	vecEnabled := true
	dbConnect := vecDBConnect
	if strings.TrimSpace(os.Getenv("PB_VEC_DISABLED")) == "1" {
		vecEnabled = false
		dbConnect = core.DefaultDBConnect
	}

	app := pocketbase.NewWithConfig(pocketbase.Config{
		DBConnect: dbConnect,
	})

	// Register the JS runtime (goja) so pb_hooks/*.pb.js and
	// pb_migrations/*.js are loaded - same as the stock binary.
	jsvm.MustRegister(app, jsvm.Config{
		HooksWatch: true,
	})

	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		// Register the vector search API (Go route, not JS, so we can scan
		// dbx results into typed structs without goja binding issues).
		// Note: register BEFORE se.Next() so the routes are in the built mux.
		se.Router.GET("/api/vec/health", func(e *core.RequestEvent) error {
			enabled := false
			var n sql.NullFloat64
			if err := e.App.DB().NewQuery("SELECT vec1_config('nthread')").Row(&n); err == nil && n.Valid {
				enabled = true
			}
			return e.JSON(http.StatusOK, map[string]any{
				"enabled": enabled,
			})
		})

		se.Router.GET("/api/vec/search", func(e *core.RequestEvent) error {
			vec := e.Request.URL.Query().Get("vector")
			if vec == "" {
				return e.BadRequestError("Missing required query parameter: vector", nil)
			}
			if !vecRe.MatchString(vec) {
				return e.BadRequestError("vector must be a float array literal, e.g. [1, 1, 1]", nil)
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
					"FROM vec_items(vec1_from_json({:vec}), {:limit}) "+
					"LIMIT {:limit}",
			).Bind(dbx.Params{
				"vec":   vec,
				"limit": limit,
			}).All(&results)
			if err != nil {
				return e.BadRequestError("vec1 query failed: "+err.Error(), nil)
			}

			return e.JSON(http.StatusOK, map[string]any{"results": results})
		})

		if err := se.Next(); err != nil {
			return err
		}

		if vecEnabled {
			log.Println("==> vec1 vector search enabled (ncruces SQLite driver + vec1 extension)")
		} else {
			log.Println("==> PB_VEC_DISABLED=1: using stock PocketBase SQLite driver")
		}

		return nil
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}

// vecRe validates a vector literal like "[1, 2, 3]" or "[-0.5, 1e3]".
var vecRe = mustRe(`^\[[\d.,\s\-+eE]+\]$`)

func mustRe(pattern string) *regexp.Regexp {
	return regexp.MustCompile(pattern)
}
