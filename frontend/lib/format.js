function formatHour(hour) {
  const h = Number(hour);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:00 ${period}`;
}

function formatMode(mode) {
  if (mode === "virtual") return "Virtual";
  if (mode === "mixed") return "Mixed";
  return "In-Person";
}

module.exports = { formatHour, formatMode };
