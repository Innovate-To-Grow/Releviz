function formatHour(hour) {
  const h = Number(hour);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:00 ${period}`;
}

function formatTime(time) {
  if (typeof time !== "string" || !/^\d{2}:\d{2}$/.test(time)) return "Not set";
  const [hour, minute] = time.split(":").map(Number);
  if (hour > 23 || minute > 59) return "Not set";
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

function formatMode(mode) {
  if (mode === "virtual") return "Virtual";
  if (mode === "mixed") return "Mixed";
  return "In-Person";
}

module.exports = { formatHour, formatMode, formatTime };
