import { NOS } from './nos';

export const sros = new NOS('sros', 'SR OS', '.sros.cfg', 'latest_sros_', 'nokia/7x50_YangModels', (tag) => {
	const m = tag.match(/^sros_(.+)$/);
	return m ? m[1].toUpperCase() : null;
});
