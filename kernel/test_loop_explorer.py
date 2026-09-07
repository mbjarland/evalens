"""Real-pipe evidence for loop boundaries, identities and unchanged execution."""
import ast
import asyncio
import contextlib
import json
import unittest
from unittest.mock import patch

import loops
from capture import OutputCapture, OUTPUT_LIMIT
from loop_explorer import LoopExplorer, ENTRY_LIMIT, BODY_VALUE_LIMIT
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

    def test_single_loop_pairs_target_and_output_without_losing_body_history(self):
        result, wire = self.run_loop('for n in range(3):\n'
                                    '    square = n * n\n'
                                    '    print(square)\n')
        self.assertEqual(result['stdout'], '0\n1\n4\n')
        self.assertEqual(len(wire['sites']), 1)
        iterations = wire['entries'][1:]
        self.assertEqual([e['value'] for e in iterations], ['0', '1', '2'])
        self.assertEqual([result['stdout'][e['start'][0]:e['end'][0]]
                          for e in iterations], ['0\n', '1\n', '4\n'])
        self.assertEqual(result['bindings'][0]['values'], ['0', '1', '4'])
        self.assertEqual(wire['sites'][0]['body_names'], ['square'])
        self.assertEqual([e['body'] for e in iterations], [
            dict(status='captured', values=[dict(name='square', value=value)])
            for value in ('0', '1', '4')])
        self.assertEqual(wire['final_values'], [{'name': 'n', 'value': '2'},
                                               {'name': 'square', 'value': '4'}])

    def test_body_values_match_iteration_identity_across_continue_and_break(self):
        _, wire = self.run_loop('for v in range(6):\n'
                                '    if v == 0: continue\n'
                                '    if v in (1, 3): u = 4 * v\n'
                                '    if v == 3: break\n')
        self.assertEqual([e['body'] for e in wire['entries'][1:]], [
            dict(status='not-reached', values=[]),
            dict(status='captured', values=[dict(name='u', value='4')]),
            dict(status='captured', values=[dict(name='u', value='4')]),
            dict(status='not-reached', values=[]),
        ])

    def test_unbound_deleted_and_unproven_names_never_inherit_snapshot_text(self):
        self.assertTrue(self.kernel.evaluate('u = 99', 0)['ok'])
        _, wire = self.run_loop('for v in range(5):\n'
                                '    if v == 1: u = 99\n'
                                '    if v == 2: u = 8\n'
                                '    if v == 3: del u\n')
        bodies = [e['body'] for e in wire['entries'][1:]]
        self.assertTrue(all(body['status'] == 'captured' for body in bodies))
        self.assertEqual([body['values'] for body in bodies],
                         [[], [], [dict(name='u', value='8')], [], []])

    def test_repeated_assignments_and_finally_capture_at_normal_body_end(self):
        result, wire = self.run_loop('for v in [1, 2, 3]:\n'
                                    '    try:\n'
                                    '        u = v\n'
                                    '        print(u)\n'
                                    '        u = 4 * v\n'
                                    '    finally:\n'
                                    '        u += 1\n')
        self.assertEqual(result['stdout'], '1\n2\n3\n')
        self.assertEqual([e['body']['values'] for e in wire['entries'][1:]],
                         [[dict(name='u', value=v)] for v in ('5', '9', '13')])

    def test_body_values_follow_lexical_loop_and_reused_target_identity(self):
        _, wire = self.run_loop('for v in [10, 20]:\n'
                                '    outer = v\n'
                                '    u = 0\n'
                                '    for v in [1, 2]:\n'
                                '        u = 10 * v\n')
        self.assertEqual([site['body_names'] for site in wire['sites']],
                         [['outer', 'u'], ['u']])
        by_id = {entry['id']: entry for entry in wire['entries']}
        for entry in wire['entries']:
            if entry['kind'] != 'iteration':
                continue
            site = by_id[entry['invocation']]['site']
            expected = ([dict(name='outer', value=entry['value']),
                         dict(name='u', value='20')] if site == 0 else
                        [dict(name='u', value=str(int(entry['value']) * 10))])
            self.assertEqual(entry['body']['values'], expected)

    def test_body_mutable_snapshot_is_the_existing_repr_from_that_iteration(self):
        self.assertTrue(self.kernel.evaluate('items = []', 0)['ok'])
        result, wire = self.run_loop('for v in range(3):\n'
                                    '    u = items\n'
                                    '    items.append(v)\n')
        expected = ['[0]', '[0, 1]', '[0, 1, 2]']
        self.assertEqual(result['bindings'][0]['values'], expected)
        self.assertEqual([e['body']['values'][0]['value']
                          for e in wire['entries'][1:]], expected)

    def test_body_capture_has_name_value_and_statement_budgets(self):
        _, wire = self.run_loop('for v in range(10000):\n'
                                '    a = b = c = d = "😀" * 1000\n')
        self.assertEqual(wire['sites'][0]['body_names'], ['a', 'b', 'c'])
        self.assertEqual(wire['sites'][0]['omitted_body_names'], 1)
        self.assertEqual(len(wire['entries']), ENTRY_LIMIT)
        self.assertEqual(wire['omitted_iterations'], 10000 - ENTRY_LIMIT + 1)
        for entry in wire['entries'][1:]:
            self.assertEqual(len(entry['body']['values']), 3)
            self.assertTrue(all(len(value['value']) <= BODY_VALUE_LIMIT
                                for value in entry['body']['values']))
        self.assertLess(len(json.dumps(wire, ensure_ascii=False)), 1800000)

    def test_overlong_body_names_are_counted_without_expanding_explorer_wire(self):
        name = 'long_' + 'a' * 5000
        _, wire = self.run_loop('for v in range(2):\n'
                                '    ' + name + ' = v\n')
        self.assertEqual(wire['sites'][0]['body_names'], [])
        self.assertEqual(wire['sites'][0]['omitted_body_names'], 1)
        self.assertTrue(all('body' not in e for e in wire['entries']))
        self.assertNotIn(name, json.dumps(wire['entries']))

    def test_body_wire_bounds_reused_long_custom_and_failed_repr_text(self):
        self.assertTrue(self.kernel.evaluate(
            'class Long:\n    def __repr__(self):\n'
            '        return "😀" * 2000\n', 0)['ok'])
        self.assertTrue(self.kernel.evaluate(
            'class Failed:\n    def __repr__(self):\n'
            '        raise ValueError("🦉" * 2000)\n', 0)['ok'])
        for expression in ('"😀" * 2000', 'Long()', 'Failed()'):
            with self.subTest(expression=expression):
                result, wire = self.run_loop('for v in [0]:\n'
                                            '    u = ' + expression + '\n')
                original = result['bindings'][0]['values'][0]
                expected = (original if len(original) <= BODY_VALUE_LIMIT else
                            original[:BODY_VALUE_LIMIT - 1] + '…')
                self.assertEqual(wire['entries'][1]['body']['values'],
                                 [dict(name='u', value=expected)])
                self.assertLessEqual(len(expected), BODY_VALUE_LIMIT)

    def test_single_loop_continue_break_and_finally_preserve_exact_intervals(self):
        result, wire = self.run_loop('for n in range(5):\n'
                                    '    try:\n'
                                    '        if n == 0: continue\n'
                                    '        print(n)\n'
                                    '        if n == 2: break\n'
                                    '    finally:\n'
                                    '        print("done", n)\n'
                                    'else:\n    print("not reached")\n')
        self.assertEqual(result['stdout'], 'done 0\n1\ndone 1\n2\ndone 2\n')
        self.assertEqual(wire['iterations'], 3)
        self.assertEqual([result['stdout'][e['start'][0]:e['end'][0]]
                          for e in wire['entries'][1:]],
                         ['done 0\n', '1\ndone 1\n', '2\ndone 2\n'])

    def test_single_empty_loop_else_output_is_not_an_iteration(self):
        result, wire = self.run_loop('for n in []:\n    print("never")\n'
                                    'else:\n    print("😀 empty")\n')
        self.assertEqual(result['stdout'], '😀 empty\n')
        self.assertEqual(wire['iterations'], 0)
        self.assertEqual(len(wire['entries']), 1)
        self.assertEqual(wire['entries'][0]['end'], [8, 0])
        self.assertEqual(wire['final_values'], [])

    def test_single_loop_capture_adds_no_user_repr_or_body_calls(self):
        result = self.kernel.send(op='eval_file', source=(
            'events = []\n'
            'class Item:\n'
            '    def __repr__(self):\n'
            '        events.append("repr")\n'
            '        return "item"\n'
            'items = [Item()]\n'
            'for item in items:\n'
            '    events.append("body")\n'))
        self.assertTrue(all(r['ok'] for r in result['results']))
        self.assertIn('loop_explorer', result['results'][-1])
        # The existing loop trace pays three repr calls: items assignment,
        # target capture, then the final named reading. Boundaries add none.
        self.assertEqual(self.kernel.evaluate('events', 0)['value'],
                         "['repr', 'repr', 'body', 'repr']")

    def test_single_loop_disabled_unsupported_and_failed_paths_stay_flat(self):
        self.kernel.evaluate('a = [0]', 0)
        for source, options, ok in (
                ('for n in range(2):\n    print(n)',
                 {'limits': {'loop_values': 0}}, True),
                ('for a[0] in range(2):\n    print(a[0])', {}, True),
                ('for n in range(2):\n    print(n)\n    1 / 0', {}, False),
                ('while False:\n    pass', {}, True),
                ('[n * n for n in range(3)]', {}, True)):
            with self.subTest(source=source):
                result = self.kernel.evaluate(source, 0, **options)
                self.assertEqual(result['ok'], ok)
                self.assertNotIn('loop_explorer', result)

    def test_single_million_pass_loop_keeps_only_bounded_entries(self):
        _, wire = self.run_loop('for n in range(1000000):\n    pass\n')
        self.assertEqual(wire['iterations'], 1000000)
        self.assertEqual(wire['invocations'], 1)
        self.assertEqual(len(wire['entries']), ENTRY_LIMIT)
        self.assertEqual(wire['omitted_iterations'], 1000000 - ENTRY_LIMIT + 1)
        self.assertEqual(wire['entries'][0]['count'], 1000000)
        self.assertTrue(all(e['end'] == [0, 0] for e in wire['entries']))
        self.assertLess(len(json.dumps(wire)), 400000)

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

    def test_site_names_do_not_expand_the_wire_or_final_snapshot_budget(self):
        names = ', '.join('item_%05d' % i for i in range(5000))
        _, wire = self.run_loop('for x in [0]:\n'
                                '    for (' + names + ') in [range(5000)]:\n'
                                '        pass\n')
        self.assertTrue(all('names' not in site for site in wire['sites']))
        self.assertLessEqual(len(wire['final_values']), 8)
        self.assertLess(len(json.dumps(wire)), 4000)

    def test_else_child_records_parent_invocation_without_parent_iteration(self):
        _, wire = self.run_loop('for x in [0]:\n    pass\nelse:\n'
                                '    for y in [1, 2]:\n        print(y)\n')
        invocations = [e for e in wire['entries'] if e['kind'] == 'invocation']
        self.assertIsNone(invocations[1]['parent'])
        self.assertEqual(invocations[1]['parent_invocation'], invocations[0]['id'])

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
    def test_body_capture_without_frames_is_explicitly_unavailable(self):
        node, plan, watches, sites = loops.instrument_exploring(
            ast.parse('for v in [1]:\n    u = 4 * v\n').body[0])
        capture = LoopExplorer(sites, OutputCapture(), OutputCapture())
        recorders = loops.watching_traces(plan, watches, repr)
        recorders[0].explorer = capture
        namespace = {}
        with patch.object(loops, '_FRAME', None), loops.installed(namespace, recorders):
            exec(compile(ast.Module(body=[node], type_ignores=[]),
                         '<no frame fixture>', 'exec', dont_inherit=True), namespace)
        self.assertEqual(namespace['u'], 4)
        self.assertEqual(capture.entries[1]['body'],
                         dict(status='unavailable', values=[]))

    def test_body_capture_reuses_repr_and_does_not_run_user_code_again(self):
        outcomes = []
        for exploring in (False, True):
            events = []
            class Item:
                def __repr__(self):
                    events.append('repr')
                    return 'item'
            def assign():
                events.append('assign')
                return Item()
            source = 'for v in range(3):\n    u = assign()\n'
            node = ast.parse(source).body[0]
            if exploring:
                node, plan, watches, sites = loops.instrument_exploring(node)
            else:
                node, plan, watches = loops.instrument_watching(node, {})
            recorders = loops.watching_traces(plan, watches, repr)
            if exploring:
                capture = LoopExplorer(sites, OutputCapture(), OutputCapture())
                recorders[0].explorer = capture
            namespace = dict(assign=assign)
            with loops.installed(namespace, recorders):
                exec(compile(ast.Module(body=[node], type_ignores=[]),
                             '<repr fixture>', 'exec', dont_inherit=True), namespace)
            outcomes.append((events, recorders[0].bindings_wire()))
        self.assertEqual(outcomes[0], outcomes[1])
        self.assertEqual(outcomes[1][0], ['assign', 'repr'] * 3)
        self.assertEqual([e['body']['values'] for e in capture.entries[1:]],
                         [[dict(name='u', value='item')]] * 3)

    def test_single_explorer_matches_prior_trace_execution_and_repr_counts(self):
        source = ('for n in values():\n'
                  '    events.append(("body", n))\n'
                  '    try:\n'
                  '        if n == 0: continue\n'
                  '        square = n * n\n'
                  '        if n == 2: break\n'
                  '    finally:\n'
                  '        print("finally", n)\n')
        outcomes = []
        for exploring in (False, True):
            events = []
            def describe(value):
                events.append(('repr', value))
                return repr(value)
            def values():
                for n in range(5):
                    events.append(('next', n))
                    print('draw', n)
                    yield n
            node = ast.parse(source).body[0]
            if exploring:
                node, plan, watch_plan, sites = loops.instrument_exploring(node)
            else:
                node, plan, watch_plan = loops.instrument_watching(node, {})
            out = OutputCapture()
            recorders = loops.watching_traces(plan, watch_plan, describe)
            if exploring:
                capture = LoopExplorer(sites, out, OutputCapture())
                for i, trace in enumerate(recorders):
                    trace.explorer, trace.site = capture, i
            namespace = {'events': events, 'values': values}
            with loops.installed(namespace, recorders), contextlib.redirect_stdout(out):
                exec(compile(ast.Module(body=[node], type_ignores=[]),
                             '<single fixture>', 'exec', dont_inherit=True), namespace)
            outcomes.append((events, out.getvalue(), recorders[0].wire(),
                             recorders[0].bindings_wire(), namespace['square']))
        self.assertEqual(outcomes[0], outcomes[1])

    def test_single_async_for_keeps_boundaries_across_continue_and_else(self):
        tree = ast.parse('async def run():\n'
                         '    async for n in values():\n'
                         '        if n == 0: continue\n'
                         '        print(n)\n'
                         '    else:\n        print("done")\n')
        async def values():
            for value in (0, 1, 2):
                yield value
        node, plan, watch_plan, sites = loops.instrument_exploring(tree.body[0].body[0])
        tree.body[0].body[0] = node
        out = OutputCapture()
        capture = LoopExplorer(sites, out, OutputCapture())
        recorders = loops.watching_traces(plan, watch_plan, repr)
        recorders[0].explorer = capture
        namespace = {'values': values}
        with loops.installed(namespace, recorders), contextlib.redirect_stdout(out):
            exec(compile(tree, '<single async fixture>', 'exec', dont_inherit=True), namespace)
            asyncio.run(namespace['run']())
        self.assertEqual(out.getvalue(), '1\n2\ndone\n')
        self.assertEqual([e['end'] for e in capture.entries],
                         [[9, 0], [0, 0], [2, 0], [4, 0]])
        self.assertEqual(capture.stack, [])

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
