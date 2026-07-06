const url = import.meta.env.VITE_CHAT_SERVICE_URL;
if (url === undefined) {
  throw new Error("VITE_CHAT_SERVICE_URL is not set.");
}

export const CHAT_SERVICE_URL: string = url;
