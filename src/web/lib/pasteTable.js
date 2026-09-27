// Cells copied from Google Sheets or Excel arrive tab-separated; a snippet
// copied from a CSV file arrives comma-separated with optional double quotes.
// This only previews the paste on the client; the server parses the real one.

const QUOTE = '"';

function parseTabbed(source) {
  return source.split("\n").map((line) => line.split("\t"));
}

// RFC 4180-style: quoted cells may hold the delimiter, newlines, and
// doubled quotes ("") for a literal quote.
function parseDelimited(source, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char !== QUOTE) {
        cell += char;
      } else if (source[index + 1] === QUOTE) {
        cell += QUOTE;
        index += 1;
      } else {
        quoted = false;
      }
    } else if (char === QUOTE && cell === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function isBlankRow(row) {
  return row.every((cell) => cell.trim() === "");
}

/**
 * Parse pasted spreadsheet text into rows of cell strings.
 *
 * Tab-separated when any line has a tab, otherwise comma-separated honouring
 * double quotes. Trailing empty lines are dropped. `columns` is the widest
 * row; ragged rows are returned as pasted.
 */
export function parsePastedTable(text) {
  const source = String(text ?? "").replace(/\r\n?/g, "\n");
  const delimiter = source.includes("\t") ? "\t" : ",";
  const rows =
    delimiter === "\t" ? parseTabbed(source) : parseDelimited(source, ",");
  while (rows.length && isBlankRow(rows[rows.length - 1])) rows.pop();
  const columns = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  return { rows, columns, delimiter };
}
