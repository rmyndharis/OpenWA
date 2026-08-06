package openwa

import "context"

// Log levels passed to Logger.Log by the SDK's built-in middleware.
const (
	LevelDebug = "debug"
	LevelInfo  = "info"
	LevelWarn  = "warn"
	LevelError = "error"
)

// Logger is the minimal logging surface the SDK depends on. Inject your own
// implementation with WithLogger to bridge to slog, zap, logrus, or any other
// logger. kv is a flat list of alternating key/value pairs (like slog).
//
// A slog bridge is a few lines:
//
//	type slogLogger struct{ l *slog.Logger }
//	func (s slogLogger) Log(ctx context.Context, level, msg string, kv ...any) {
//	    s.l.Log(ctx, slog.LevelInfo, msg, kv...)
//	}
type Logger interface {
	Log(ctx context.Context, level string, msg string, kv ...any)
}

// nopLogger discards all log records. It is the default when no logger is
// injected, so the SDK never writes anywhere the caller did not ask for.
type nopLogger struct{}

func (nopLogger) Log(context.Context, string, string, ...any) {}
