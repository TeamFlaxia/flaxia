/** Time-to-live for in-memory ZIP caches (ms). */
export const ZIP_TTL = 5 * 60 * 1000;

/** Maximum uncompressed size of extracted ZIP content (100 MB). */
export const ZIP_MAX_TOTAL_SIZE = 100 * 1024 * 1024;

/** Maximum number of files allowed in a ZIP archive. */
export const ZIP_MAX_FILE_COUNT = 1024;

/** Maximum path depth allowed in ZIP entries. */
export const ZIP_MAX_PATH_DEPTH = 10;

/** Maximum length of a single path segment. */
export const ZIP_MAX_PATH_LENGTH = 255;

/** Timeout for iframe loading (ms). */
export const ZIP_LOADING_TIMEOUT = 30_000;

/** Timeout for SW controller readiness (ms). */
export const ZIP_SW_CONTROLLER_TIMEOUT = 10_000;

/** Timeout for ZIP readiness message from SW (ms). */
export const ZIP_READY_TIMEOUT = 10_000;

/** Timeout for ZIP fetch (ms). */
export const ZIP_FETCH_TIMEOUT = 15_000;
