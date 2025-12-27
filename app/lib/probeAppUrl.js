import fetch from "node-fetch";

export async function probeAppUrl(url) {
  try {
    const r = await fetch(url, { method: "GET" });
    return {
      url,
      status: r.status,
      contentType: r.headers.get("content-type")
    };
  } catch (e) {
    return {
      url,
      error: e.message
    };
  }
}