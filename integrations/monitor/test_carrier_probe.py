import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('probe',Path(__file__).with_name('carrier-probe.py'))
probe=importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

class ProbeTest(unittest.TestCase):
    def test_loss_from_packet_counters(self):
        result=probe.parse_ping('cu','192.0.2.1','5 packets transmitted, 4 received, 20% packet loss, time 4000ms\nrtt min/avg/max/mdev = 110.000/120.000/140.000/2.000 ms',0)
        self.assertEqual(result['received'],4)
        self.assertEqual(result['avgMs'],120)
        self.assertIsNone(result['error'])
    def test_no_reply_is_loss_but_permission_is_unknown(self):
        loss=probe.parse_ping('cm','192.0.2.1','5 packets transmitted, 0 received, 100% packet loss',1)
        self.assertEqual(loss['sent'],5)
        self.assertIsNone(loss['avgMs'])
        denied=probe.parse_ping('cm','192.0.2.1','ping: socket: Operation not permitted',2)
        self.assertEqual(denied['sent'],0)
        self.assertEqual(denied['error'],'permission')
    def test_interrupted_and_malformed_sampling_not_counted_as_loss(self):
        self.assertEqual(probe.parse_ping('ct','192.0.2.1','2 packets transmitted, 0 received',1)['error'],'parse')
        self.assertEqual(probe.parse_ping('ct','192.0.2.1','5 packets transmitted, 5 received',0)['error'],'parse')
    def test_no_redirect_can_forward_credentials(self):
        self.assertIsNone(probe.NoRedirect().redirect_request(None,None,302,'Found',{},'https://elsewhere.test'))
if __name__=='__main__':unittest.main()
