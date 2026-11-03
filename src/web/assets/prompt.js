// Plays the prompt anatomy: blocks light up one by one while the totals count up. The drawing and
// the final numbers are already in the page, so without this script the finished prompt shows.
// It reads the page's data block, which holds only labels and numbers, and fetches nothing.
import {
  formatCount,
  frameAt,
  stepNumber,
  stepStart,
  TIMING,
  totalsAt,
} from "./prompt-view.js";

const stage = document.getElementById("pa-stage");
const dataBlock = document.getElementById("pa-data");
if (stage && dataBlock) start(stage, JSON.parse(dataBlock.textContent ?? "{}"));

function start(stage, data) {
  const blocks = Array.isArray(data.blocks) ? data.blocks : [];
  const total = blocks.length;
  const counts = {};
  for (const name of ["blocks", "tokens", "checks", "records"]) {
    counts[name] = stage.querySelector(`[data-count="${name}"]`);
  }
  const caption = document.getElementById("pa-caption");
  const announce = document.getElementById("pa-announce");
  const controls = document.getElementById("pa-controls");
  const replayButton = document.getElementById("pa-replay");
  const playButton = document.getElementById("pa-pause");
  const backButton = document.getElementById("pa-prev");
  const nextButton = document.getElementById("pa-next");
  const allButton = document.getElementById("pa-all");
  const clock = stage.querySelector(".pa-clock");
  const animated = [...stage.querySelectorAll("[data-at]")];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let mode = "auto";
  let paused = false;
  let done = false;
  let step = total;
  let frameRequest = 0;
  let shownCaption = null;
  let shownStep = -1;

  function setText(element, text) {
    if (element && element.textContent !== text) element.textContent = text;
  }

  function say(text) {
    setText(announce, text);
  }

  function show(frame) {
    setText(counts.blocks, String(frame.step));
    setText(counts.tokens, formatCount(frame.tokens));
    setText(counts.checks, String(frame.passed));
    setText(counts.records, String(frame.records));
    const key = frame.done ? "done" : frame.step;
    if (key === shownCaption) return;
    shownCaption = key;
    const block = blocks[frame.step - 1];
    if (frame.done) setText(caption, data.summary);
    else if (!block) setText(caption, `${data.intro}…`);
    else
      setText(
        caption,
        `${stepNumber(block.step)} ${block.label} — ${block.meaning}`,
      );
  }

  /** The CSS animation that runs for the whole assembly; its time is the stage's time. */
  function elapsed() {
    if (typeof clock?.getAnimations !== "function") return null;
    const animation = clock.getAnimations()[0];
    return animation ? Number(animation.currentTime ?? 0) : null;
  }

  function currentStep() {
    if (mode === "manual") return step;
    const ms = elapsed();
    return ms === null ? total : frameAt(blocks, ms).step;
  }

  function updateButtons() {
    const playing = mode === "auto" && !paused && !done;
    setText(playButton, playing ? "Pause" : "Play");
    playButton.title = playing
      ? "Pause the assembly"
      : "Play the assembly from here";
    const at = currentStep();
    backButton.disabled = at <= 0;
    nextButton.disabled = done || (mode === "manual" && at >= total);
    allButton.disabled = done || (mode === "manual" && at >= total);
  }

  function tick() {
    frameRequest = 0;
    if (mode !== "auto") return;
    const ms = elapsed();
    if (ms === null) {
      done = true;
      show({ ...totalsAt(blocks, total), done: true });
      updateButtons();
      return;
    }
    const frame = frameAt(blocks, ms);
    show(frame);
    if (frame.done) {
      done = true;
      say(data.summary);
      updateButtons();
      return;
    }
    if (frame.step !== shownStep) {
      shownStep = frame.step;
      updateButtons();
    }
    if (!paused) frameRequest = requestAnimationFrame(tick);
  }

  /** Moves between auto and manual without transitions replaying what is already on screen. */
  function switchMode(next) {
    stage.classList.add("pa-instant");
    stage.classList.remove("pa-auto", "pa-manual", "pa-paused");
    if (next === "manual") {
      for (const element of animated) {
        element.classList.toggle("is-on", Number(element.dataset.at) <= step);
      }
    }
    void stage.offsetWidth;
    stage.classList.add(next === "auto" ? "pa-auto" : "pa-manual");
    mode = next;
    requestAnimationFrame(() => stage.classList.remove("pa-instant"));
  }

  /** Plays the CSS animations from `ms` after the start. */
  function playFrom(ms) {
    cancelAnimationFrame(frameRequest);
    paused = false;
    done = false;
    switchMode("auto");
    if (ms > 0) {
      for (const animation of stage.getAnimations({ subtree: true })) {
        animation.currentTime = ms;
      }
    }
    shownCaption = null;
    shownStep = -1;
    say("");
    tick();
    updateButtons();
  }

  function goTo(target) {
    cancelAnimationFrame(frameRequest);
    frameRequest = 0;
    paused = false;
    step = Math.max(0, Math.min(target, total));
    done = step === total;
    if (mode === "manual") {
      for (const element of animated) {
        element.classList.toggle("is-on", Number(element.dataset.at) <= step);
      }
    } else {
      switchMode("manual");
    }
    const totals = totalsAt(blocks, step);
    show({ ...totals, done });
    const block = blocks[step - 1];
    say(
      done
        ? data.summary
        : block
          ? `${stepNumber(block.step)} ${block.label} added. About ${formatCount(totals.tokens)} tokens so far.`
          : "No blocks yet.",
    );
    updateButtons();
  }

  function togglePlay() {
    if (mode === "auto" && !done) {
      paused = !paused;
      stage.classList.toggle("pa-paused", paused);
      if (!paused && frameRequest === 0)
        frameRequest = requestAnimationFrame(tick);
      updateButtons();
      return;
    }
    const from = mode === "manual" && step < total ? step : 0;
    playFrom(from === 0 ? 0 : stepStart(from) + TIMING.light);
  }

  controls.hidden = false;
  replayButton.addEventListener("click", () => playFrom(0));
  playButton.addEventListener("click", togglePlay);
  backButton.addEventListener("click", () => goTo(currentStep() - 1));
  nextButton.addEventListener("click", () => goTo(currentStep() + 1));
  allButton.addEventListener("click", () => goTo(total));

  stage.classList.add("pa-live");
  if (reduceMotion.matches) {
    replayButton.hidden = true;
    goTo(total);
    return;
  }
  tick();
  updateButtons();
}
