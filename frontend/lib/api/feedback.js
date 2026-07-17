import { API_BASE, apiFetch, extractError } from "./config";

export async function submitFeedback({
  category,
  message,
  pagePath = "",
  consentToFollowUp = false,
}) {
  const res = await apiFetch(`${API_BASE}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      category,
      message,
      pagePath,
      consentToFollowUp,
    }),
  });
  if (!res.ok) throw new Error(await extractError(res));
  return res.json();
}
