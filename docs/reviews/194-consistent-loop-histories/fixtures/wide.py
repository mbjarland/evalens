import sys
a, b, c, d, e = [1], [2], [3], [4], [5]
for total in a + b + c + d + e:
    b1 = total
    b2 = total * 2
    b3 = total * 3
    print(total)
    print(total, file=sys.stderr)

broken =
