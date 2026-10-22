import { notFound } from "next/navigation";

export default async function ModalItem({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "missing") notFound();
  return <p id="slot-own-modal-item">Modal item {id}</p>;
}
