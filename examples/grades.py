scores = [72, 85, 91, 64]
total = 0
for s in scores:
    total += s
average = total / len(scores)
passed = [s for s in scores if s >= 70]
print(f"{len(passed)} passed, average {average:.1f}")

# This is the program in the README's first picture, kept to seven lines so
# the line numbers match it. Press Cmd+Alt+Enter (Ctrl+Alt+Enter elsewhere)
# to run the file and read down the right-hand side.
#
# Then try the exercise the second picture shows: change `total += s` on
# line 4 to `total = s` and run it again. The loop's history reads
# `total x4: 72, 85, 91, 64` -- it never accumulates -- and `average: 16.0`
# follows from it two lines later. A debugger stopped at the end would show
# `total: 64` and nothing about how it got there.
