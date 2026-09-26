/** How this device names itself: in prompt lines, on the passkey, in the API client. */
export const LABEL = /iPhone|iPad/.test(navigator.userAgent) ? "iphone" : "browser";
