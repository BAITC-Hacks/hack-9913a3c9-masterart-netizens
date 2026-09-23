import {useEffect, useState} from 'react';
import {validateAnalysis} from '../data/schema';
import {buildIndex, type GraphIndex} from '../data/graph';

/** Загрузка out/analysis.json с честными состояниями: загрузка, файла нет, файл неверен, готово. */
export type AnalysisState =
  | {status: 'loading'}
  | {status: 'missing'; detail: string}
  | {status: 'invalid'; errors: string[]}
  | {status: 'ready'; index: GraphIndex; warnings: string[]};

export const ANALYSIS_URL = '/out/analysis.json';

export function useAnalysis(): AnalysisState {
  const [state, setState] = useState<AnalysisState>({status: 'loading'});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let response: Response;
      try {
        response = await fetch(ANALYSIS_URL, {cache: 'no-store'});
      } catch {
        if (!cancelled) setState({status: 'missing', detail: 'Локальный сервер не ответил.'});
        return;
      }
      if (!response.ok) {
        if (!cancelled) setState({status: 'missing', detail: `Сервер ответил ${response.status}.`});
        return;
      }
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        if (!cancelled) setState({status: 'invalid', errors: ['Файл не является корректным JSON.']});
        return;
      }
      const result = validateAnalysis(raw);
      if (cancelled) return;
      setState(result.ok ? {status: 'ready', index: buildIndex(result.data), warnings: result.warnings} : {status: 'invalid', errors: result.errors});
    })();
    return () => { cancelled = true; };
  }, []);
  return state;
}
