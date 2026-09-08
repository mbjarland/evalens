scores = [72, 85, 91, 64]
total = 0
for s in scores:
    total += s
average = total / len(scores)
passed = [s for s in scores if s >= 70]
print(f"{len(passed)} passed, average {average:.1f}")
