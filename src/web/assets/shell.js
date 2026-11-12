// Shell behavior: ⌘K / Ctrl+K opens the jump menu. Without this script the
// menu still works as a plain <details> disclosure.
const jump = document.querySelector("details.jump");
if (jump) {
  const firstLink = () => jump.querySelector(".jump-menu a");
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      jump.open = !jump.open;
      if (jump.open) firstLink()?.focus();
    }
    if (event.key === "Escape" && jump.open) {
      jump.open = false;
      jump.querySelector("summary")?.focus();
    }
  });
  jump.addEventListener("click", (event) => {
    if (event.target.closest("a")) jump.open = false;
  });
}
