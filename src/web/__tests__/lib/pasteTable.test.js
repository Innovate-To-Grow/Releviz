import { parsePastedTable } from "@/lib/pasteTable";

test("splits on tabs when any line has one and keeps ragged rows", () => {
  const result = parsePastedTable(
    "name\temail\tgroup\nAda\tada@example.com\nGrace\tgrace@example.com\tStaff, Team 3\n",
  );
  expect(result).toEqual({
    delimiter: "\t",
    columns: 3,
    rows: [
      ["name", "email", "group"],
      ["Ada", "ada@example.com"],
      ["Grace", "grace@example.com", "Staff, Team 3"],
    ],
  });
});

test("parses comma-separated text honouring double quotes", () => {
  const result = parsePastedTable(
    'name,email,note\r\n"Lovelace, Ada",ada@example.com,"says ""hi""\nand more"\r\nGrace,grace@example.com,\r\n',
  );
  expect(result.delimiter).toBe(",");
  expect(result.columns).toBe(3);
  expect(result.rows).toEqual([
    ["name", "email", "note"],
    ["Lovelace, Ada", "ada@example.com", 'says "hi"\nand more'],
    ["Grace", "grace@example.com", ""],
  ]);
});

test("keeps a quote that does not open a cell as a literal character", () => {
  expect(parsePastedTable("Ada 5'10\" tall,x").rows).toEqual([
    ["Ada 5'10\" tall", "x"],
  ]);
});

test("drops trailing empty lines but keeps blank rows in the middle", () => {
  expect(parsePastedTable("a,b\n\nc,d\n\n  \n")).toEqual({
    delimiter: ",",
    columns: 2,
    rows: [["a", "b"], [""], ["c", "d"]],
  });
  expect(parsePastedTable("a\tb\n\t\n")).toEqual({
    delimiter: "\t",
    columns: 2,
    rows: [["a", "b"]],
  });
});

test("returns no rows for empty or whitespace-only input", () => {
  expect(parsePastedTable("")).toEqual({
    rows: [],
    columns: 0,
    delimiter: ",",
  });
  expect(parsePastedTable("   \n")).toEqual({
    rows: [],
    columns: 0,
    delimiter: ",",
  });
  expect(parsePastedTable(null)).toEqual({
    rows: [],
    columns: 0,
    delimiter: ",",
  });
});
