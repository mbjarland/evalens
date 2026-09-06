"""Read built-in storage and format values without dispatching user methods."""
import functools
import itertools
import types


_TYPE_DICT = type.__dict__["__dict__"]
_TYPE_MRO = type.__dict__["__mro__"]
_TYPE_NAME = type.__dict__["__qualname__"]
_MISSING = object()


def mro(kind):
    return _TYPE_MRO.__get__(kind)


def member(kind, name):
    for base in mro(kind):
        members = _TYPE_DICT.__get__(base)
        if name in members:
            return members[name]
    return _MISSING


def type_name(value):
    return _TYPE_NAME.__get__(type(value)).replace("<locals>.", "")[:120]


def own_dict(value):
    descriptor = member(type(value), "__dict__")
    if type(descriptor) is not types.GetSetDescriptorType:
        return None
    try:
        own = descriptor.__get__(value)
        return own if any(base is dict for base in mro(type(own))) else None
    except TypeError:
        return None


def properties(value):
    found = {}
    seen = set()
    for base in mro(type(value)):
        for name, descriptor in _TYPE_DICT.__get__(base).items():
            if type(name) is not str or name in seen:
                continue
            seen.add(name)
            if any(kind is property or kind is functools.cached_property
                   for kind in mro(type(descriptor))):
                found[name] = descriptor
    return found


def base_type(value):
    """Preserve the existing rule that customized container reads are opaque."""
    kind = type(value)
    for base in (dict, list, tuple, set, frozenset):
        if not any(parent is base for parent in mro(kind)):
            continue
        methods = ("__len__", "__iter__")
        if base is dict:
            methods += ("__getitem__", "items")
        elif base is list or base is tuple:
            methods += ("__getitem__",)
        if all(member(kind, name) is member(base, name) for name in methods):
            return base
    return None


def items(value, base):
    return dict.items(value) if base is dict else enumerate(base.__iter__(value))


def text(value, limit=1024):
    """A bounded display of native values; custom objects remain descriptions."""
    budget = [100]
    active = set()

    def render(value, depth):
        budget[0] -= 1
        if budget[0] < 0:
            return "…"
        kind = type(value)
        if kind is str or kind is bytes:
            clipped = value[:limit]
            return repr(clipped) + (" …" if len(value) > limit else "")
        if kind is int:
            if int.bit_length(value) > limit * 3:
                return "<large int>"
            return repr(value)
        if any(kind is primitive for primitive in
               (float, complex, bool, type(None))):
            return repr(value)
        base = base_type(value)
        if base is None:
            return "<" + type_name(value) + " instance>"
        if depth == 0 or id(value) in active:
            return "<" + type_name(value) + " …>"
        active.add(id(value))
        try:
            length = base.__len__(value)
            rows = []
            for key, child in itertools.islice(items(value, base), 6):
                part = render(child, depth - 1)
                if base is dict:
                    part = render(key, depth - 1) + ": " + part
                rows.append(part)
            if length > len(rows):
                rows.append("…")
            if base is list:
                return "[" + ", ".join(rows) + "]"
            if base is tuple:
                return "(" + ", ".join(rows) + ("," if length == 1 else "") + ")"
            if base is dict:
                return "{" + ", ".join(rows) + "}"
            content = "{" + ", ".join(rows) + "}" if length else "set()"
            return "frozenset(" + content + ")" if base is frozenset else content
        finally:
            active.remove(id(value))

    result = render(value, 3)
    return result if len(result) <= limit else result[:limit] + "…"
