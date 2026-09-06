"""Inspection is observational even for objects with implicit Python hooks."""
import unittest
from test_kernel import KernelProcess


class PassiveInspection(unittest.TestCase):
    def setUp(self):
        self.k = KernelProcess(control=False)
        self.addCleanup(self.k.close)

    def test_inspection_never_dispatches_user_hooks(self):
        source = """
calls = []
class Meta(type):
    def __getattribute__(self, name):
        calls.append('meta:' + name)
        return super().__getattribute__(name)
    def __eq__(self, other):
        calls.append('meta:eq')
        return self is other
    __hash__ = type.__hash__
class Object(metaclass=Meta):
    def __init__(self):
        self.child = {'safe': 1}
    def __getattribute__(self, name):
        calls.append('attr:' + name)
        return object.__getattribute__(self, name)
    def __repr__(self):
        calls.append('repr')
        return 'custom'
    @property
    def risky(self):
        calls.append('property')
        return 42
class Mapping(dict):
    def items(self):
        calls.append('items')
        return super().items()
class Sequence(list):
    def __iter__(self):
        calls.append('iter')
        return super().__iter__()
class Key:
    def __repr__(self):
        calls.append('key repr')
        return 'key'
obj = Object()
mapping = Mapping(a=1)
sequence = Sequence([1, 2])
root = {'obj': obj, Key(): obj, 'mapping': mapping, 'sequence': sequence}
calls.clear()
"""
        loaded = self.k.send(op="eval_file", source=source)
        self.assertTrue(all(r["ok"] for r in loaded["results"]), loaded)
        for name in ("obj", "mapping", "sequence", "root"):
            result = self.k.inspect(name)
            self.assertTrue(result["ok"], result)
            for child in result["children"]:
                if child.get("step") is not None:
                    self.assertTrue(self.k.inspect(
                        name, path=[child["step"]])["ok"])
        self.assertEqual(self.k.evaluate("calls", 0)["value"], "[]")

    def test_shadowed_and_cached_properties_are_not_duplicated(self):
        self.k.send(op="eval_file", source="""
import functools
class Base:
    @property
    def hidden(self): return 99
class Child(Base):
    hidden = 1
    @functools.cached_property
    def cached(self): return 2
obj = Child()
obj.cached
""")
        result = self.k.inspect("obj")
        self.assertEqual([c["name"] for c in result["children"]], ["cached"])
        self.assertEqual(result["children"][0]["value"], "2")

    def test_cycles_and_huge_values_remain_bounded(self):
        self.k.send(op="eval_file", source=(
            "obj = []\nobj.append(obj)\n"
            "huge = ['x' * 1000000, 10 ** 100000]\n"))
        for name in ("obj", "huge"):
            result = self.k.inspect(name)
            self.assertTrue(result["ok"])
            self.assertLess(len(str(result)), 20000)
