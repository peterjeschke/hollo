import type { PropsWithChildren } from "hono/jsx";

export function SiteHeader(props: PropsWithChildren) {
  return (
    <header class="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div class="px-5 pb-6 sm:px-7">
        <h1 class="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
          <a href="/">Peter Jeschke</a>
        </h1>
        <p class="mt-1 flex flex-wrap items-center gap-x-2 text-sm">
          <span
            style="select-all text-neutral-500 dark:text-neutral-400"
            title="Use this handle to reach out to me on your fediverse server!"
          >
            @peter@jeschke.dev
          </span>
        </p>
        {props.children}
      </div>
    </header>
  );
}
