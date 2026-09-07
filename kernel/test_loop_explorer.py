"""Real-pipe evidence for nested identities and unchanged execution."""
import ast
import asyncio
import json
import unittest

import loops
from capture import OutputCapture, OUTPUT_LIMIT
from loop_explorer import LoopExplorer, ENTRY_LIMIT
from test_kernel import KernelProcess


class LoopExplorerKernelTest(unittest.TestCase):
    def setUp(self):
        self.kernel = KernelProcess(control=False)
        self.addCleanup(self.kernel.close)

    def run_loop(self, source, line=0, **extra):
        result = self.kernel.evaluate(source, line, **extra)
        self.assertTrue(result['ok'], result)
        return result, result['loop_explorer']

    def test_silent_repeated_values_have_distinct_parents(self):
        _, wire = self.run_loop(
            'for x in [0, 0]:\n'
            '    for y in [1, 1]:\n'
            '        pass\n'
            '    for y in [1, 1]:\n'
            '        pass\n')
        inv = [e for e in wire['entries'] if e['kind'] == 'invocation']
        outer = [e for e in wire['entries'] if e['kind'] == 'iteration'
                 and e['invocation'] == inv[0]['id']]
        self.assertEqual([i['site'] for i in inv], [0, 1, 2, 1, 2])
        self.assertEqual([i['parent'] for i in inv[1:]],
                         [outer[0]['id']] * 2 + [outer[1]['id']] * 2)
        self.assertTrue(all(e['start'] == e['end'] == [0, 0]
                            for e in wire['entries']))

    def test_three_levels_break_continue_and_unicode_streams(self):
        source = ('for x in range(2):\n'
                  '    print("😀", x)\n'
                  '    for y in range(3):\n'
                  '        if y == 0: continue\n'
                  '        for z in range(3):\n'
                  '            print("🦉", x, y, z)\n'
                  '            if z == 1: break\n')
        result, wire = self.run_loop(source)
        expected = ''.join('😀 %s\n' % x + ''.join(
            '🦉 %s %s %s\n' % (x, y, z)
            for y in (1, 2) for z in (0, 1)) for x in (0, 1))
        self.assertEqual(result['stdout'], expected)
        self.assertEqual(wire['retained'], [len(expected), 0])
        by_id = {e['id']: e for e in wire['entries']}
        for invocation in wire['entries']:
            if invocation['kind'] != 'invocation' or invocation['site'] != 2:
                continue
            parent = by_id[invocation['parent']]
            self.assertEqual(by_id[parent['invocation']]['site'], 1)
            self.assertIn(parent['value'], ('1', '2'))

    def test_iterator_and_else_output_are_not_last_iteration_output(self):
        setup = ('def items():\n'
                 '    print("before")\n'
                 '    yield 1\n'
                 '    print("between")\n'
                 '    yield 2\n'
                 '    print("after")\n')
        self.assertTrue(self.kernel.evaluate(setup, 0)['ok'])
        result, wire = self.run_loop(
            'for x in [0]:\n'
            '    for y in items():\n'
            '        try:\n'
            '            print(y)\n'
            '        finally:\n'
            '            print("finally")\n'
            '    else:\n'
            '        print("else")\n')
        self.assertEqual(result['stdout'],
                         'before\n1\nfinally\nbetween\n2\nfinally\nafter\nelse\n')
        inner = next(e for e in wire['entries']
                     if e['kind'] == 'invocation' and e['site'] == 1)
        pieces = [result['stdout'][e['start'][0]:e['end'][0]]
                  for e in wire['entries'] if e['kind'] == 'iteration'
                  and e['invocation'] == inner['id']]
        self.assertEqual(pieces, ['1\nfinally\n', '2\nfinally\n'])

    def test_stderr_separate_and_success_snapshots_not_iteration_values(self):
        self.assertTrue(self.kernel.evaluate('import sys', 0)['ok'])
        result, wire = self.run_loop(
            'for x in range(2):\n'
            '    for y in range(2):\n'
            '        print(x, y, file=sys.stderr)\n'
            '    x = 99\n')
        self.assertEqual(result['stdout'], '')
        self.assertEqual(result['stderr'], '0 0\n0 1\n1 0\n1 1\n')
        self.assertEqual(wire['final_values'],
                         [{'name': 'x', 'value': '99'},
                          {'name': 'y', 'value': '1'}])
        outer = [e['value'] for e in wire['entries']
                 if e['kind'] == 'iteration' and e['invocation'] == 1]
        self.assertEqual(outer, ['0', '1'])

    def test_failure_keeps_original_output_and_omits_incomplete_tree(self):
        result = self.kernel.evaluate(
            'for x in range(2):\n'
            '    for y in range(2):\n'
            '        print(x, y)\n'
            '        1 / 0\n', 0)
        self.assertFalse(result['ok'])
        self.assertEqual(result['stdout'], '0 0\n')
        self.assertEqual(result['error']['type'], 'ZeroDivisionError')
        self.assertNotIn('loop_explorer', result)

    def test_file_and_watch_requests_share_capture_without_watch_replay(self):
        source = 'for x in range(2):\n    for y in range(2):\n        print(y)\n'
        file_result = self.kernel.send(op='eval_file', source=source)
        self.assertIn('loop_explorer', file_result['results'][0])
        watched = self.kernel.watch(source, 1, '1 / y', character=4)
        self.assertTrue(watched['ok'])
        self.assertEqual(watched['stdout'], '0\n1\n0\n1\n')
        self.assertIn('ZeroDivisionError', watched['stderr'])
        self.assertIn('loop_explorer', watched)

    def test_unreadable_targets_and_disabled_tracing_keep_flat_output(self):
        self.kernel.evaluate('a = [0]', 0)
        source = ('for x in range(2):\n'
                  '    for a[0] in range(2):\n'
                  '        print(a[0])\n')
        for options in ({}, {'limits': {'loop_values': 0}}):
            result = self.kernel.evaluate(source, 0, **options)
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['stdout'], '0\n1\n0\n1\n')
            self.assertNotIn('loop_explorer', result)

    def test_budget_is_statement_wide_and_retained_nodes_still_close(self):
        _, wire = self.run_loop('for x in range(100):\n'
                                '    for y in range(100):\n'
                                '        pass\n')
        self.assertEqual(len(wire['entries']), ENTRY_LIMIT)
        self.assertEqual(wire['iterations'], 10100)
        self.assertEqual(wire['invocations'], 101)
        self.assertEqual(wire['omitted_iterations']
                         + wire['omitted_invocations'], 10201 - ENTRY_LIMIT)
        self.assertTrue(all(e['end'] is not None for e in wire['entries']))
        self.assertEqual(wire['entries'][0]['count'], 100)
        self.assertLess(len(json.dumps(wire)), 400000)

    def test_huge_output_has_bounded_retention_and_original_offsets(self):
        result, wire = self.run_loop(
            'for x in range(2):\n'
            '    for y in range(2):\n'
            '        print("😀" * 100000)\n')
        self.assertEqual(wire['retained'], [OUTPUT_LIMIT, 0])
        self.assertEqual(wire['totals'], [400004, 0])
        self.assertTrue(result['stdout'].startswith('😀' * OUTPUT_LIMIT))
        self.assertIn('334,468 characters omitted', result['stdout'])
        self.assertGreater(wire['entries'][-1]['start'][0], OUTPUT_LIMIT)

    def test_explorer_adds_no_user_repr_calls(self):
        source = ('events = []\n'
                  'class Item:\n'
                  '    def __repr__(self):\n'
                  '        events.append("repr")\n'
                  '        return "item"\n'
                  'items = [Item()]\n'
                  'for x in items:\n'
                  '    for y in items:\n'
                  '        pass\n')
        result = self.kernel.send(op='eval_file', source=source)
        self.assertTrue(all(r['ok'] for r in result['results']))
        # Existing capture calls repr five times: items assignment, two
        # target readings and the original final names. The explorer reuses
        # target text and its new final snapshots are passive (no extra call).
        self.assertEqual(self.kernel.evaluate('len(events)', 0)['value'], '5')


class LoopExplorerBoundariesTest(unittest.TestCase):
    def test_budget_edges_and_async_for_use_explicit_parent_identity(self):
        source = ('async def run():\n'
                  '    async for x in values():\n'
                  '        async for y in values():\n'
                  '            pass\n')
        async def values():
            for value in (0, 0):
                yield value
        for limit in (1, 2, 3, 8, 9, 10):
            tree = ast.parse(source)
            node, plan, watch_plan, sites = loops.instrument_exploring(
                tree.body[0].body[0])
            tree.body[0].body[0] = node
            capture = LoopExplorer(sites, OutputCapture(), OutputCapture(),
                                   limit=limit)
            recorders = loops.watching_traces(plan, watch_plan, repr)
            for index, trace in enumerate(recorders):
                trace.explorer, trace.site = capture, index
            namespace = {'values': values}
            with loops.installed(namespace, recorders):
                exec(compile(tree, '<async fixture>', 'exec'), namespace)
                asyncio.run(namespace['run']())
            self.assertEqual(len(capture.entries), min(limit, 9))
            self.assertTrue(all(e['end'] is not None for e in capture.entries))
            self.assertEqual(capture.stack, [])
