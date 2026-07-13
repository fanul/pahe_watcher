import { $, api } from './state.js';

export function initManualJob(refreshAll) {
  $('#manualJobForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const url = f.url.value.trim();
    if (!url) return;
    
    try {
      await api('/jobs', {
        method: 'POST',
        body: JSON.stringify({ url, title: 'Manual Link Submit', provider: 'Manual' })
      });
      f.url.value = '';
      refreshAll();
    } catch (err) {
      alert(`Failed to add manual job: ${err.message}`);
    }
  };
}
