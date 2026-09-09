"""
A short Python file, written to be watched rather than read.

Every line here is chosen to put one thing on screen. Open it in VS Code
with Evalens installed, put the cursor on line 1, and hold Cmd+Shift+Enter
(Ctrl+Shift+Enter elsewhere) to walk down it. Each press evaluates the
statement you are on and moves to the next.

It is ordinary Python. `python3 examples/demo.py` runs it and prints the
same things it always would; nothing in this file exists for the tool.
"""

import math

# ---------------------------------------------------------------- 1. a value
# The whole idea, in one line: press the key, the answer appears beside the
# code and stays there.

greeting = "hello"

# --------------------------------------------------------- 2. the same list
# Two names, one list. This is the thing a terminal cannot show you, because
# it prints one value at a time and then scrolls it away.

lst = [1, 2, 3]
other = lst
other.append(4)
lst

# ------------------------------------------------------------- 3. a rebind
# And now they are two lists. The line below changes `lst` and leaves
# `other` alone -- visible in one glance, because both values are still on
# screen from a moment ago.

lst = [9, 9]
other

# --------------------------------------------------------------- 4. a loop
# A loop reports its target history and up to three selected body-name
# histories side by side. Each puts its values first, then `5 iterations`,
# so a history does not read as a list that happens to have five items.

for n in range(5):
    squared = n * n
    print("n is", n)

# ------------------------------------------------------- 5. a comprehension
# A comprehension hides its loop. Evalens shows it: the values `n` took are
# painted beside the list they built, which is the part a beginner cannot
# see and most needs to.

squares = [n * n for n in range(6)]

# ---------------------------------------------------------- 6. what it said
# `print()` returns None, and saying "None" would be useless. The line says
# what was printed instead, and a statement that both binds and prints says
# both.

total = sum(squares)
print("the total is", total)

# --------------------------------------------------------------- 7. a table
# A list of records renders as a table on hover, without pandas installed.
# Hover `crew` to see it.

crew = [
    {"name": "Ada Lovelace", "born": 1815, "field": "computing"},
    {"name": "Grace Hopper", "born": 1906, "field": "compilers"},
    {"name": "Katherine Johnson", "born": 1918, "field": "orbital mechanics"},
]

# -------------------------------------------------------------- 8. an object
# Hover `p` for its fields. Note `magnitude`: a property is *listed and never
# called*, because annotating your code must never run your code. That is a
# rule, not an oversight -- a getter with a side effect would fire every time
# you looked at a line.


class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y

    @property
    def magnitude(self):
        return math.hypot(self.x, self.y)


p = Point(3, 4)
# ------------------------------------------------------------ 9. and again
# The namespace remembers, so this sees everything above it.

f"{greeting}, {len(crew)} people, {total}"

# ------------------------------------------------------------- 10. an error
# An error is an answer too: it lands on the line that raised, in the error
# colour, and a whole-file load carries on to the next statement rather than
# stopping. It sits last so `python3 examples/demo.py` reaches every line
# above it first -- run as a script this is where Python stops, which is
# exactly what the annotation beside it says.

int("not a number")
