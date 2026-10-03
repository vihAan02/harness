// Environment names a project secret may never use (D-52, D-87; security.md TH-21). harnessd builds each
// session's environment from allowlisted secrets plus its own variables, and the vendor CLI reads its
// auth, endpoint, proxy and runtime settings from the same environment. A secret named like one of those
// could send the key to another host, swap the model, or load code into the CLI, so these names are
// refused both when the local config is read and again when a session opens (fail closed).

/**
 * Name prefixes the vendor CLIs and runtimes read: auth, endpoint, model and telemetry settings, loaders.
 * The pinned Claude Code CLI is a Bun-compiled binary (F-78): `BUN_OPTIONS=--preload <file>` runs a file in
 * the CLI process, outside the sandbox, and `BUN_CONFIG_VERBOSE_FETCH` prints request headers, key included.
 * `SSL_` covers TLS trust and `SSL_KEYLOG_FILE`, which would let traffic to the model endpoint be decrypted.
 */
const RESERVED_PREFIXES = ['ANTHROPIC_', 'CLAUDE', 'OPENAI_', 'CODEX_', 'OTEL_', 'NODE_', 'BUN_', 'NPM_CONFIG_', 'DYLD_', 'LD_', 'HARNESS_', 'GIT_', 'SSL_'];
/** Exact names: the base environment, proxies, TLS trust, and the ports harnessd hands out (D-68). */
const RESERVED_NAMES = new Set([
  'PATH', 'HOME', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'DEBUG',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'PORT',
]);

/** True for names a project secret may not take. Case-insensitive, since proxies are read in either case. */
export function isReservedEnvName(name: string): boolean {
  const n = name.toUpperCase();
  return RESERVED_NAMES.has(n) || RESERVED_PREFIXES.some((p) => n.startsWith(p));
}
