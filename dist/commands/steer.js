"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmdSteer = cmdSteer;
const steering_1 = require("../steering");
const format_1 = require("./format");
function cmdSteer(args) {
    if (args[0] === "--clear" || args[0] === "-c") {
        (0, steering_1.clearSteering)();
        console.log(format_1.c.dim("Cleared any pending steering."));
        return 0;
    }
    const replace = args.includes("--replace");
    const message = args.filter((a) => a !== "--replace").join(" ").trim();
    if (!message) {
        const pending = (0, steering_1.peekSteering)();
        if (pending) {
            console.log(format_1.c.bold("Pending steering (delivers at the agent's next tool call):"));
            console.log("  " + pending.replace(/\n/g, "\n  "));
        }
        else {
            console.log(format_1.c.dim("No steering queued."));
            console.log("");
            console.log("Usage: " + format_1.c.cyan('reins steer "the detail you forgot to put in the prompt"'));
            console.log(format_1.c.dim('e.g.   reins steer "focus the auth work on the token refresh path"'));
        }
        return 0;
    }
    const hadPending = (0, steering_1.peekSteering)() !== null;
    if (replace || !hadPending) {
        (0, steering_1.writeSteering)(message);
        console.log(format_1.c.green("✓ Steering queued."));
    }
    else {
        // Don't silently drop the earlier nudge — combine them.
        const count = (0, steering_1.appendSteering)(message);
        console.log(format_1.c.green(`✓ Added to pending steering (${count} nudges queued).`));
        console.log(format_1.c.dim("  Use --replace to overwrite instead, or `reins steer --clear` to reset."));
    }
    console.log(format_1.c.dim("It reaches the agent at its next tool call — its next decision point — " +
        "then clears (one-shot). The run keeps going; nothing is interrupted."));
    return 0;
}
