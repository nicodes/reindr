import { homedir } from "node:os";
import path from "node:path";
export const REINDR_DEFAULT_PORT = 7676;
export function booleanOption(value, fallback) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "string")
        return value !== "0" && value.toLowerCase() !== "false";
    return fallback;
}
export function portOption(value, fallback) {
    if (value === undefined || value === null || value === "")
        return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535)
        return fallback;
    return parsed;
}
export function normalizeAssetOrigins(values) {
    const origins = new Set();
    for (const value of values) {
        if (typeof value !== "string" || !value.trim())
            continue;
        try {
            const url = new URL(value.includes("://") ? value : `https://${value}`);
            if (url.protocol !== "https:")
                continue;
            if (url.pathname !== "/" || url.search || url.hash || url.username || url.password)
                continue;
            origins.add(url.origin);
        }
        catch { }
    }
    return [...origins];
}
export function resolveFile(worktree, value) {
    const expanded = value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
    return path.isAbsolute(expanded) ? expanded : path.resolve(worktree, expanded);
}
export function dataHome(environment = process.env) {
    const configured = environment.XDG_DATA_HOME;
    return configured && path.isAbsolute(configured)
        ? configured
        : path.join(homedir(), ".local", "share");
}
export function resolveReindrConfig(worktree, options = {}, environment = process.env) {
    const allowedOption = Array.isArray(options.allowedAssetHosts) ? options.allowedAssetHosts : [];
    const allowedEnvironment = (environment.REINDR_ALLOWED_ASSET_HOSTS ?? "").split(",");
    const directoryOption = typeof options.canvasDirectory === "string"
        ? options.canvasDirectory
        : path.join(dataHome(environment), "reindr", "sessions");
    const canvasDirectory = resolveFile(worktree, environment.REINDR_DIRECTORY ?? directoryOption);
    const templateOption = typeof environment.REINDR_TEMPLATE_DIRECTORY === "string"
        ? environment.REINDR_TEMPLATE_DIRECTORY
        : typeof options.templateDirectory === "string"
            ? options.templateDirectory
            : path.join(path.dirname(canvasDirectory), "templates");
    const configuredPort = portOption(environment.REINDR_PORT ?? options.port, NaN);
    return {
        preferredPort: Number.isNaN(configuredPort) ? REINDR_DEFAULT_PORT : configuredPort,
        portExplicit: !Number.isNaN(configuredPort),
        autoOpen: booleanOption(environment.REINDR_AUTORAISE ?? options.autoOpen, true),
        browserCommand: typeof environment.REINDR_BROWSER === "string"
            ? environment.REINDR_BROWSER
            : typeof options.browser === "string"
                ? options.browser
                : null,
        canvasDirectory,
        templateDirectory: resolveFile(worktree, templateOption),
        allowedAssetOrigins: normalizeAssetOrigins([...allowedOption, ...allowedEnvironment]),
        stylesheetPath: typeof environment.REINDR_STYLESHEET === "string"
            ? environment.REINDR_STYLESHEET
            : typeof options.stylesheetPath === "string"
                ? options.stylesheetPath
                : null,
    };
}
export function jsonBytes(value) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
        throw new Error("not JSON serializable");
    return Buffer.byteLength(encoded, "utf8");
}
export function recordValue(value) {
    return value && typeof value === "object" ? value : null;
}
export function limitedText(value, limit = 20_000) {
    const text = typeof value === "string" ? value : value == null ? "" : String(value);
    return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}
export function sessionPath(sessionID) {
    return `/s/${encodeURIComponent(sessionID)}`;
}
export function canvasFileName(sessionID) {
    if (!sessionID)
        throw new Error("Session ID cannot be empty");
    const encoded = encodeURIComponent(sessionID).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return `${encoded}.html`;
}
export function escapeHTML(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
