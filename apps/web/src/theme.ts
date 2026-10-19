import { useEffect, useState } from 'react';

/**
 * Preferência visual do operador (escuro é o padrão). É a única informação guardada
 * no navegador: não contém dados de negócio, credenciais nem identificadores.
 */
export type Theme = 'dark' | 'light';
const THEME_KEY = 'wysetef-theme';

function readTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // armazenamento indisponível (janela privada): segue com o tema em memória
    }
  }, [theme]);
  return [theme, setTheme];
}
