"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

export function Tabs() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <nav>
      <button
        data-testid="search-transition-archived-tab"
        onClick={() => {
          startTransition(() => {
            router.replace("?archived=1", { scroll: false });
          });
        }}
      >
        Archived
      </button>
      <span data-testid="search-transition-pending">{String(isPending)}</span>
    </nav>
  );
}
