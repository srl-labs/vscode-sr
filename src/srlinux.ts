import { NOS } from './nos';

export const srlinux = new NOS('srlinux', 'SR Linux', '.srl.cfg', 'srlinux_', 'nokia/srlinux-yang-models', (tag) => {
	const m = tag.match(/^v(.+)$/);
	return m ? m[1] : null;
});
