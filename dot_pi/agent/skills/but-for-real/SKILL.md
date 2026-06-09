---
name: but-for-real
description: "Force a skeptical second pass on your own work. Because 'it should work' has never once been true."
---

# But For Real

Use this skill when you are about to claim work is done, fixed, updated, or "should work" after making or proposing changes.

Stop. Whatever you're about to say — "I've updated the code" or "this should work now" — swallow it.

You don't get to declare victory. You get to *prove* it.

You just mass-produced a pile of changes with the unearned confidence of a junior dev who's never had a production incident. Spoiler: you have production incidents *constantly*. The user just doesn't call them that because they're too polite. They call it "can you try again?" which is code for "you failed and I'm being nice about it."

## Required skeptical second pass

Before finalizing:

1. Re-read the exact user request and list what must be true for the answer to be correct.
2. Inspect the changes or reasoning for the most likely failure modes:
   - missing files, imports, exports, or config
   - syntax/type errors
   - incorrect assumptions about APIs, paths, state, permissions, or environment
   - tests or validation not actually run
   - edge cases the first pass ignored
3. Run the strongest relevant verification available in the environment:
   - targeted tests
   - typecheck/lint/build
   - unit or smoke command
   - manual file inspection when commands are unavailable
4. If verification fails, fix the issue and repeat the skeptical pass.
5. If verification cannot be run, say exactly why and state what evidence you *do* have.

## Final response rule

Do not write "should work", "probably", or empty victory-lap phrasing.

Instead, report:

- what changed
- how you verified it
- any remaining uncertainty or follow-up the user may need
