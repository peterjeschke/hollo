export function SiteHeader() {
  return (
    <hgroup>
      <h1>
        <a href="/">Peter Jeschke</a>
      </h1>
      <p>
        <span
          style="user-select: all;"
          data-tooltip="Use this handle to reach out to me on your fediverse server!"
          data-placement="bottom"
        >
          @peter@jeschke.dev
        </span>
      </p>
    </hgroup>
  );
}
