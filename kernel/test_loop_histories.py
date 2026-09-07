"""Inline nested histories come from live recorders, never retained tree rows."""
import unittest
from test_kernel import KernelProcess


class NestedLoopHistoryTest(unittest.TestCase):
    def setUp(self):
        self.kernel = KernelProcess(control=False)
        self.addCleanup(self.kernel.close)

    def histories(self, source, **options):
        result = self.kernel.evaluate(source, 0, **options)
        self.assertTrue(result['ok'], result)
        return result, result['loop_explorer']['histories']

    def test_uniform_counts_survive_exhausted_iteration_detail(self):
        result, histories = self.histories(
            'for x in range(100):\n'
            '    for y in range(100):\n'
            '        print(x, y)\n')
        outer, inner = histories
        self.assertEqual(outer, dict(site=0, invocations=1, count=100,
                                     values=['0', '1', '2', '3', '4'], last='99'))
        self.assertEqual(inner, dict(site=1, invocations=100, count=10000,
                                     values=['0', '1', '2', '3', '4'], last='99'))
        self.assertGreater(result['loop_explorer']['omitted_iterations'], 8000)
        self.assertEqual(len(result['stdout'].splitlines()), 10000)

    def test_varying_inner_runs_keep_aggregate_execution_order(self):
        _, histories = self.histories('for x in range(4):\n'
                                      '    for y in range(x): pass\n')
        self.assertEqual(histories[1], dict(site=1, invocations=4, count=6,
                                           values=['0', '0', '1', '0', '1'],
                                           last='2'))

    def test_empty_and_unreached_are_different(self):
        for outer, expected_runs in (('range(2)', 2), ('[]', 0)):
            with self.subTest(outer=outer):
                _, histories = self.histories('for x in %s:\n'
                                              '    for y in []: pass\n' % outer)
                self.assertEqual(histories[1], dict(site=1,
                    invocations=expected_runs, count=0, values=[], last=None))

    def test_break_and_continue_count_only_iterations_entered(self):
        _, histories = self.histories(
            'for x in range(4):\n'
            '    if x == 0: continue\n'
            '    for y in range(9):\n'
            '        if y == 1: break\n')
        self.assertEqual(histories[1], dict(site=1, invocations=3, count=6,
                                           values=['0', '1', '0', '1', '0'],
                                           last='1'))

    def test_reused_names_have_separate_source_histories(self):
        _, histories = self.histories('for x in [3, 4]:\n'
                                      '    for x in [7, 8]: pass\n')
        self.assertEqual(histories[0]['values'], ['3', '4'])
        self.assertEqual(histories[1]['values'], ['7', '8', '7', '8'])
        self.assertEqual([h['site'] for h in histories], [0, 1])

    def test_three_levels_and_siblings_do_not_interleave_sites(self):
        _, histories = self.histories(
            'for x in range(2):\n'
            '    for y in range(3):\n'
            '        for z in range(y): pass\n'
            '    for y in [9]: pass\n')
        self.assertEqual([(h['count'], h['invocations']) for h in histories],
                         [(2, 1), (6, 2), (6, 6), (2, 2)])
        self.assertEqual(histories[2]['values'], ['0', '0', '1', '0', '0'])
        self.assertEqual(histories[3]['values'], ['9', '9'])

    def test_history_wire_is_bounded_even_with_oversized_requested_head(self):
        _, histories = self.histories(
            'for x in range(2):\n    for y in range(100): pass\n',
            limits={'loop_values': 10000})
        inner = histories[1]
        self.assertEqual(len(inner['values']), 50)
        self.assertEqual(inner['count'], 200)
        self.assertEqual(inner['last'], '99')

    def test_all_supported_sites_survive_detail_limit_and_too_many_fail_flat(self):
        for children in (63, 64):
            source = 'for x in range(100):\n' + ''.join(
                '    for y%d in range(2): pass\n' % i for i in range(children))
            result = self.kernel.evaluate(source, 0)
            self.assertTrue(result['ok'], result)
            if children == 64:
                self.assertNotIn('loop_explorer', result)
            else:
                wire = result['loop_explorer']
                self.assertEqual(len(wire['histories']), 64)
                self.assertGreater(wire['omitted_invocations'], 0)
                self.assertTrue(all(h['invocations'] == 100 and h['count'] == 200
                                    for h in wire['histories'][1:]))

    def test_saved_histories_add_no_repr_calls(self):
        source = ('events = []\n'
                  'class Item:\n'
                  '    def __repr__(self):\n'
                  '        events.append("repr")\n'
                  '        return "item"\n'
                  'items = [Item()]\n'
                  'for x in items:\n'
                  '    for y in items: pass\n')
        result = self.kernel.send(op='eval_file', source=source)
        histories = result['results'][-1]['loop_explorer']['histories']
        self.assertEqual([h['values'] for h in histories], [['item'], ['item']])
        # Same five calls as the established explorer capture regression:
        # assignment, targets and original final-name values. No new calls.
        self.assertEqual(self.kernel.evaluate('len(events)', 0)['value'], '5')
