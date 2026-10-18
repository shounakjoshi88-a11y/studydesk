# JNCIA-Junos 1-Page Cheat Sheet (JN0-106)

**Exam:** 65Q 90min ~65% $200 Pearson VUE Junos 21.2 valid 3yr

**Networking:** collision per-port, broadcast per-VLAN/router. Switch L2 MAC 48-bit, Router L3. /30=2 hosts P2P. Longest match wins. TCP handshake reliable, UDP fast.

**Junos:** FreeBSD single image. RE=control (RIB `show route`, protocols). PFE=forward (FIB `show route forwarding-table`, filters). Transit PFE-only, exception to RE.

**CLI:** `>` operational, `#` configure. `?` help, `| match/count`. `set` edits candidate, `commit` activates. `show | compare`, `rollback 0` discard, `rollback 1..50` restore (max 50). `commit check` validate, `commit confirmed 5` safety, `save`, `load override`, `request system configuration rescue save`.

**Config:** must set `host-name` + root. `ge-`1G `xe-`10G `et-`100G `lo0` `fxp0/em0` mgmt. Classes: super-user/operator/read-only/unauthorized. Groups via apply-groups. NTP/SNMP/syslog/archival (transfer-on-commit).

**Monitor:** `show interfaces terse/extensive`, `monitor interface traffic` (stats) vs `monitor traffic` (sniff), ping/traceroute, `show chassis alarms`, `request system software add validate reboot`, recovery boot -s.

**Routing:** RIB RE vs FIB PFE. Pref: Direct 0 Static 5 RSVP 7 LDP 9 OSPF 10 IS-IS 15 RIP 100 Agg 130 OSPF-ext 150 BGP 170 — lower wins. `inet.0` default. Static: `set routing-options static route 0/0 next-hop X`. Dynamic = auto-converge/scale.

**Policy vs Filter:** Policy=routes accept/reject (BGP default reject). Filter=packets accept/discard (default discard). Terms top-down. `import` into RIB, `export` out. uRPF anti-spoof.

Print this + score 85% twice -> book exam.
