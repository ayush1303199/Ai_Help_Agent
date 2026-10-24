'use client';

import { useState } from 'react';

const initialForm = {
  "customerName": "",
  "Required": ""
};

export default function OrderForm() {
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  function updateArrayField(field, index, key, value) { setForm((current) => ({ ...current, [field]: current[field].map((item, row) => row === index ? { ...item, [key]: value } : item) })); }
  function addArrayItem(field, item) { setForm((current) => ({ ...current, [field]: [...current[field], item] })); }
  function removeArrayItem(field, index) { setForm((current) => ({ ...current, [field]: current[field].filter((_, row) => row !== index) })); }
  async function submit(event) {
    event.preventDefault(); setError(''); setSuccess('');
    const clientErrors = [];
    if (typeof form["Required"] !== 'string' || form["Required"].trim() === '') clientErrors.push("Required is required.");
    if (clientErrors.length) { setError(clientErrors.join(' ')); return; }
    setLoading(true);
    try {
      const response = await fetch("/api/orders", { method: "POST", headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || result.errors?.join(', ') || 'Request failed.');
      setSuccess('Saved successfully.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed.'); }
    finally { setLoading(false); }
  }
  return <form onSubmit={submit} className="space-y-4">
      
      <label key="customerName"><span>customerName</span><input name="customerName" type="text" value={form["customerName"] ?? ''} onChange={(event) => setForm((current) => ({ ...current, ["customerName"]: event.target.value }))}  /></label>
      <label key="Required"><span>Required</span><input name="Required" type="text" value={form["Required"] ?? ''} onChange={(event) => setForm((current) => ({ ...current, ["Required"]: event.target.value }))} required /></label>

    <button type="submit" disabled={loading}>{loading ? 'Saving...' : 'Submit'}</button>
    {error && <p role="alert">{error}</p>}{success && <p role="status">{success}</p>}
  </form>;
}
