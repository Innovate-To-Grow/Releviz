/**
 * @jest-environment jsdom
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { fireEvent, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import ManageGroupsPanel from "@/components/schedule/participants/ManageGroupsPanel";

// Next hydrates React on the document itself, so React's listener and the
// drawer's own Escape listener share that node and a control's
// stopPropagation can't keep them apart. A tree rendered on the document
// shows what the usual container div hides. React sets up its document
// listeners only once per document, so this tree is the file's first render.
test("Escape in the Groups panel cancels only the rename, the new-group form or the open menu", async () => {
  const onClose = jest.fn();
  const onRename = jest.fn();
  const root = createRoot(document);
  await act(async () =>
    root.render(
      <html lang="en">
        <body>
          <ManageGroupsPanel
            groups={[
              { id: 1, name: "Design", count: 4, weight: 1, includedCount: 4 },
            ]}
            ungrouped={{ count: 0, weight: null, includedCount: 0 }}
            totals={{ total: 4 }}
            onRename={onRename}
            onCreate={jest.fn()}
            onClose={onClose}
          />
        </body>
      </html>,
    ),
  );
  const actions = screen.getByRole("button", { name: "Actions for Design" });

  fireEvent.click(actions);
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  fireEvent.keyDown(
    screen.getByRole("textbox", { name: "New name for Design" }),
    { key: "Escape" },
  );
  expect(screen.queryByRole("textbox")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "+ New group" }));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "New group name" }), {
    key: "Escape",
  });
  expect(screen.queryByRole("textbox")).toBeNull();

  fireEvent.click(actions);
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Rename" }), {
    key: "Escape",
  });
  expect(screen.queryByRole("menu")).toBeNull();

  expect(onRename).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Groups" })).toBeInTheDocument();

  // With nothing open inside, Escape closes the panel as before.
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});
