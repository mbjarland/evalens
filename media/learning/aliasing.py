# 3. Two names, one list
# Start on original; use Evalens: Evaluate and Advance down this file.
# Default key: Cmd+Shift+Enter (Ctrl+Shift+Enter on Windows/Linux).
# Before second.append(4), predict original. Then continue: expect [1, 2, 3, 4].
# Both names refer to one list. The earlier [1, 2, 3] is a snapshot from then,
# not a watch of the list now. To repeat, start from original = [1, 2, 3].
original = [1, 2, 3]
second = original
second.append(4)
original
