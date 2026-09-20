// Keep the production npm command cross-platform without adding a shell-specific env assignment.
process.env.NODE_ENV = 'production';
await import('../dist/main.js');
