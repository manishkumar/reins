import { writeSteering, appendSteering, peekSteering, clearSteering } from "../steering";
import { c } from "./format";

export function cmdSteer(args: string[]): number {
  if (args[0] === "--clear" || args[0] === "-c") {
    clearSteering();
    console.log(c.dim("Cleared any pending steering."));
    return 0;
  }

  const replace = args.includes("--replace");
  const message = args.filter((a) => a !== "--replace").join(" ").trim();

  if (!message) {
    const pending = peekSteering();
    if (pending) {
      console.log(c.bold("Pending steering (delivers at the agent's next tool call):"));
      console.log("  " + pending.replace(/\n/g, "\n  "));
    } else {
      console.log(c.dim("No steering queued."));
      console.log("");
      console.log("Usage: " + c.cyan('reins steer "the detail you forgot to put in the prompt"'));
      console.log(c.dim('e.g.   reins steer "focus the auth work on the token refresh path"'));
    }
    return 0;
  }

  const hadPending = peekSteering() !== null;
  if (replace || !hadPending) {
    writeSteering(message);
    console.log(c.green("✓ Steering queued."));
  } else {
    // Don't silently drop the earlier nudge — combine them.
    const count = appendSteering(message);
    console.log(c.green(`✓ Added to pending steering (${count} nudges queued).`));
    console.log(c.dim("  Use --replace to overwrite instead, or `reins steer --clear` to reset."));
  }
  console.log(
    c.dim(
      "It reaches the agent at its next tool call — its next decision point — " +
        "then clears (one-shot). The run keeps going; nothing is interrupted.",
    ),
  );
  return 0;
}
