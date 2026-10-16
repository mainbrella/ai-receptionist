import { VoiceAPIError, type createVoiceAPI, type VoiceNumberSearchInput, type VoiceNumberSearchResult } from './voice-api.ts';

const keypad = Object.fromEntries(['ABC', 'DEF', 'GHI', 'JKL', 'MNO', 'PQRS', 'TUV', 'WXYZ']
  .flatMap((letters, index) => [...letters].map(letter => [letter, String(index + 2)])));
export const keypadDigits = (value: string): string => value.toUpperCase().replace(/[A-Z]/g, letter => keypad[letter]).replace(/[^0-9]/g, '');
export const displayPhoneNumber = (number: string): string => /^\+1\d{10}$/.test(number)
  ? `+1 (${number.slice(2, 5)}) ${number.slice(5, 8)}-${number.slice(8)}` : number;

export function vanityParts(number: string, search: VoiceNumberSearchResult['search']): { prefix: string; word: string; suffix: string } | null {
  const word = search.query.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/[A-Z]/.test(word) || !search.digits || !/^\+1\d{10}$/.test(number)) return null;
  const national = number.slice(2), offset = search.areaCode ? 3 : 0, target = national.slice(offset);
  const index = search.match === 'starts_with' ? (target.startsWith(search.digits) ? 0 : -1)
    : search.match === 'ends_with' ? (target.endsWith(search.digits) ? target.length - search.digits.length : -1)
    : target.indexOf(search.digits);
  if (index < 0) return null;
  return { prefix: `+1 ${national.slice(0, offset + index)}${offset + index ? ' ' : ''}`, word,
    suffix: national.slice(offset + index + search.digits.length) ? ` ${national.slice(offset + index + search.digits.length)}` : '' };
}

export function numberPrice(value: string | null, currency: string): string | null {
  if (value === null || !/^\d{1,6}(?:\.\d{1,6})?$/.test(value) || !/^[A-Z]{3}$/.test(currency)) return null;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'code', maximumFractionDigits: 4 }).format(Number(value)); }
  catch { return null; }
}

export function initializeNumberSearch(api: ReturnType<typeof createVoiceAPI>, options: { isDisposed: () => boolean; onAuthError: (error: VoiceAPIError) => void }) {
  const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const form = element<HTMLFormElement>('voice-number-search');
  const query = element<HTMLInputElement>('voice-number-query');
  const areaCode = element<HTMLInputElement>('voice-number-area');
  const country = element<HTMLSelectElement>('voice-number-country');
  const match = element<HTMLSelectElement>('voice-number-match');
  const type = element<HTMLSelectElement>('voice-number-type');
  const locality = element<HTMLInputElement>('voice-number-locality');
  const region = element<HTMLInputElement>('voice-number-region');
  const similar = element<HTMLInputElement>('voice-number-similar');
  const button = element<HTMLButtonElement>('voice-number-submit');
  const error = element('voice-number-error');
  const status = element('voice-number-status');
  const results = element<HTMLUListElement>('voice-number-results');
  const preview = element('voice-number-preview');
  const copyStatus = element('voice-number-copy-status');
  let controller: AbortController | null = null;
  let revision = 0;

  const setLoading = (loading: boolean) => {
    button.disabled = loading; button.textContent = loading ? 'Searching…' : 'Search numbers';
    results.setAttribute('aria-busy', String(loading));
  };
  function update() {
    controller?.abort(); revision++; setLoading(false);
    query.setCustomValidity(''); areaCode.setCustomValidity(''); region.setCustomValidity('');
    const word = query.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    preview.textContent = /[A-Z]/.test(word) ? `${word} → ${keypadDigits(word)} on a phone keypad.`
      : 'Try a word like FLOWERS, or digits like 1010.';
    if (results.children.length) status.textContent = 'Search again to use your updated filters.';
    results.hidden = true; copyStatus.textContent = ''; error.hidden = true;
  }
  form.addEventListener('input', update);
  form.addEventListener('change', update);

  function render(result: VoiceNumberSearchResult) {
    results.replaceChildren();
    if (!result.numbers.length) {
      results.hidden = true;
      status.textContent = 'No voice numbers found. Try a shorter word, remove a location filter, or include similar results.';
      return;
    }
    const exact = result.numbers.filter(number => number.exactMatch).length;
    status.textContent = `${result.numbers.length} voice number${result.numbers.length === 1 ? '' : 's'}${result.search.query ? ` · ${exact} exact match${exact === 1 ? '' : 'es'}` : ''}${result.numbers.length === result.search.limit ? ' · Refine your search to see other numbers.' : ''}`;
    for (const number of result.numbers) {
      const row = document.createElement('li'); row.className = 'voice-number-row';
      const info = document.createElement('div'); info.className = 'voice-number-info';
      const phone = document.createElement('strong'); phone.className = 'voice-number-value'; phone.textContent = displayPhoneNumber(number.phoneNumber);
      info.append(phone);
      const parts = number.exactMatch ? vanityParts(number.phoneNumber, result.search) : null;
      if (parts) {
        const alias = document.createElement('span'); alias.className = 'voice-number-alias';
        const word = document.createElement('mark'); word.textContent = parts.word;
        alias.append(document.createTextNode(parts.prefix), word, document.createTextNode(parts.suffix)); info.append(alias);
      }
      const detail = document.createElement('span'); detail.className = 'voice-hint';
      detail.textContent = [number.location || (result.search.country === 'US' ? 'United States' : 'Canada'),
        number.exactMatch ? '' : 'Similar result'].filter(Boolean).join(' · '); info.append(detail);
      const cost = document.createElement('div'); cost.className = 'voice-number-cost';
      const monthly = number.cost && numberPrice(number.cost.monthly, number.cost.currency);
      const upfront = number.cost && numberPrice(number.cost.upfront, number.cost.currency);
      const price = document.createElement('span'); price.textContent = monthly ? `${monthly} / month` : 'Monthly price unavailable';
      cost.append(price);
      if (upfront) { const fee = document.createElement('span'); fee.className = 'voice-hint'; fee.textContent = `${upfront} setup`; cost.append(fee); }
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'quiet-button voice-number-copy'; copy.textContent = 'Copy';
      copy.setAttribute('aria-label', `Copy ${displayPhoneNumber(number.phoneNumber)}`);
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(number.phoneNumber);
          copyStatus.textContent = `${displayPhoneNumber(number.phoneNumber)} copied.`;
        } catch {
          const selection = window.getSelection(), range = document.createRange(); range.selectNodeContents(phone);
          selection?.removeAllRanges(); selection?.addRange(range);
          copyStatus.textContent = 'Copy was unavailable. The number is selected so you can copy it manually.';
        }
      });
      row.append(info, cost, copy); results.append(row);
    }
    results.hidden = false;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (options.isDisposed()) return;
    const digits = keypadDigits(query.value), max = areaCode.value.trim() ? 7 : 10;
    query.setCustomValidity(digits.length > max ? `Use up to ${max} letters or digits${max === 7 ? ' with an area code' : ', without the country code'}.`
      : query.value.trim() && !digits ? 'Enter a word or digits.' : '');
    region.value = region.value.trim().toUpperCase();
    if (!form.reportValidity()) return;
    controller?.abort(); controller = new AbortController();
    const current = ++revision, signal = controller.signal;
    const input: VoiceNumberSearchInput = {
      country: country.value as VoiceNumberSearchInput['country'], query: query.value.trim(),
      areaCode: areaCode.value.trim() || undefined, match: match.value as VoiceNumberSearchInput['match'],
      type: type.value as VoiceNumberSearchInput['type'], locality: locality.value.trim() || undefined,
      region: region.value || undefined, includeSimilar: similar.checked, limit: 50,
    };
    error.hidden = true; copyStatus.textContent = ''; status.textContent = 'Searching available voice numbers…';
    results.replaceChildren(); results.hidden = false;
    for (let index = 0; index < 3; index++) {
      const skeleton = document.createElement('li'); skeleton.className = 'voice-number-row voice-number-skeleton'; skeleton.setAttribute('aria-hidden', 'true');
      skeleton.append(document.createElement('span'), document.createElement('span')); results.append(skeleton);
    }
    setLoading(true);
    try {
      const result = await api.searchNumbers(input, signal);
      if (current !== revision || options.isDisposed()) return;
      render(result);
    } catch (caught) {
      if (signal.aborted || current !== revision || options.isDisposed()) return;
      results.replaceChildren(); results.hidden = true; status.textContent = '';
      error.textContent = caught instanceof Error ? caught.message : 'Could not search numbers. Please try again.'; error.hidden = false;
      if (caught instanceof VoiceAPIError && caught.status === 401) options.onAuthError(caught);
    } finally { if (current === revision) setLoading(false); }
  });
  return () => { revision++; controller?.abort(); };
}
