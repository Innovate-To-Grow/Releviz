import CreateEventClient from "@/components/event/CreateEventClient";

export const metadata = { title: "Edit Event - Releviz" };

export default function EditEventPage() {
  return <CreateEventClient operation="edit" />;
}
