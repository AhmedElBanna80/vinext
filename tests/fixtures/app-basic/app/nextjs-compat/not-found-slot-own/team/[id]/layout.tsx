export default function Layout({
  children,
  team,
}: {
  children: React.ReactNode;
  team: React.ReactNode;
}) {
  return (
    <section id="slot-own-team-layout">
      {children}
      <div id="slot-own-team-slot">{team}</div>
    </section>
  );
}
