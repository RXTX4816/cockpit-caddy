/**
 * Protocol presets for the proxy dialogs' ExternalAddressInput. HTTP-specific
 * on purpose (h2/h2c/h3 are HTTP/2 and HTTP/3 variants) — this is where that
 * domain knowledge belongs now that the shared component no longer bakes it in.
 */
export const EXTERNAL_ADDRESS_BUILTIN_SCHEMES = ["http", "https", "h2", "h2c", "h3"];
