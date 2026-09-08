# 4. Fix an accumulator
# Use Evalens: Evaluate File; inspect total beside the for score in scores line.
# Default key: Cmd+Alt+Enter (Ctrl+Alt+Enter on Windows/Linux).
# With Loop Values on (the default), its history is 2, 4, 6. Final total is 6.
# Why did the loop keep only the last score instead of adding all three?
# Change total = score to total += score; explicitly Evaluate File again.
# Now the history is 2, 6, 12 and the final total is 12.
# Evaluate File reruns the setup too, so earlier attempts do not add to the sum.
scores = [2, 4, 6]
total = 0
for score in scores:
    total = score
total
