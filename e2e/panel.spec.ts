import { expect, test, type Page } from '@playwright/test';

/**
 * Fluxos ponta a ponta do painel WyseTEF contra API, worker e PostgreSQL reais
 * (banco descartável criado por scripts/test-e2e.mjs). Todos os dados são fictícios.
 */
const TOKEN = process.env['E2E_ADMIN_TOKEN'] ?? '';
const run = Date.now().toString(36);
const customer = { code: `e2e-cli-${run}`, name: `Cliente E2E ${run} (fictício)` };
const merchant = { code: `loja-${run}`, name: 'Loja E2E Centro' };
const terminal = { code: `caixa-${run}`, label: 'Caixa E2E 01' };

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Token administrativo local').fill(TOKEN);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
}

async function createSimulatedPayment(page: Page, scenario: RegExp, amount: string): Promise<ReturnType<Page['getByRole']>> {
  await page.goto('/#/simulador');
  await page.getByLabel('Cliente').selectOption(customer.code);
  await expect(page.getByLabel('Terminal simulado')).toHaveValue(terminal.code);
  await page.getByLabel('Valor em reais').fill(amount);
  await page.getByRole('radio', { name: scenario }).check();
  await page.getByRole('button', { name: 'Criar pagamento simulado' }).click();
  return page.getByRole('region', { name: /Resultado do cenário/ }).first();
}

test.describe.serial('painel WyseTEF', () => {
  test('1. acesso local: recusa token inválido, entra com o token e não expõe o token na página', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('WyseTEF')).toBeVisible();
    await expect(page.getByRole('note').filter({ hasText: 'Nenhum pagamento é real' })).toBeVisible();
    await page.getByLabel('Token administrativo local').fill('token-invalido-para-teste-e2e');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByText('token inválido')).toBeVisible();

    await page.getByLabel('Token administrativo local').fill(TOKEN);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    expect(await page.content()).not.toContain(TOKEN);
    expect(await page.evaluate(() => document.cookie)).toBe(''); // sessão em cookie HttpOnly
  });

  test('2. cadastro de cliente e estabelecimento, com validação do formulário', async ({ page }) => {
    await login(page);
    await page.goto('/#/clientes');
    await page.getByRole('button', { name: 'Cadastrar cliente' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Cadastrar cliente' }).click();
    await expect(dialog.getByText('Informe a razão social')).toBeVisible();

    await dialog.getByLabel('Código').fill(customer.code);
    await dialog.getByLabel('Razão social').fill(customer.name);
    await dialog.getByRole('button', { name: 'Cadastrar cliente' }).click();
    await expect(page.getByText(`Cliente ${customer.code} cadastrado`)).toBeVisible();
    await expect(page.getByRole('table', { name: 'Clientes' }).getByText(customer.name)).toBeVisible();

    await page.goto(`/#/estabelecimentos?customerId=${customer.code}`);
    await page.getByRole('button', { name: 'Cadastrar estabelecimento' }).first().click();
    const mDialog = page.getByRole('dialog');
    await expect(mDialog.getByLabel('Cliente')).toHaveValue(customer.code);
    await mDialog.getByLabel('Código').fill(merchant.code);
    await mDialog.getByLabel('Nome').fill(merchant.name);
    await mDialog.getByRole('button', { name: 'Cadastrar estabelecimento' }).click();
    await expect(page.getByText(`Estabelecimento ${merchant.code} cadastrado`)).toBeVisible();
  });

  test('3. cadastro de terminal simulado', async ({ page }) => {
    await login(page);
    await page.goto(`/#/terminais?customerId=${customer.code}&merchantId=${merchant.code}`);
    await expect(page.getByText('Todos os terminais desta versão são simulados.')).toBeVisible();
    await page.getByRole('button', { name: 'Cadastrar terminal' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Estabelecimento')).toHaveValue(merchant.code);
    await dialog.getByLabel('Código').fill(terminal.code);
    await dialog.getByLabel('Identificação').fill(terminal.label);
    await dialog.getByRole('button', { name: 'Cadastrar terminal' }).click();
    await expect(page.getByText(`Terminal ${terminal.code} cadastrado`)).toBeVisible();
    const row = page.getByRole('table', { name: 'Terminais' }).getByRole('row').filter({ hasText: terminal.label });
    await expect(row.getByText('simulado')).toBeVisible();
    await expect(row.getByText('Operando')).toBeVisible();
  });

  test('4. pagamento simulado aprovado, com a atualização vinda do worker', async ({ page }) => {
    await login(page);
    const result = await createSimulatedPayment(page, /^Aprovação/, '25,90');
    await expect(result.getByText('Resultado simulado, não é autorização financeira')).toBeVisible();
    await expect(result.locator('.detail-head [data-state="APPROVED"]')).toBeVisible({ timeout: 20_000 });
    await expect(result.getByText('Pagamento: Aprovado')).toBeVisible();
  });

  test('5. recusa e resultado desconhecido reconciliado sem nova cobrança', async ({ page }) => {
    await login(page);
    const declined = await createSimulatedPayment(page, /^Recusa/, '10,00');
    await expect(declined.locator('.detail-head [data-state="DECLINED"]')).toBeVisible({ timeout: 20_000 });

    const unknown = await createSimulatedPayment(page, /^Falha de comunicação/, '42,00');
    await expect(unknown.locator('.detail-head [data-state="DECLINED"]')).toBeVisible({ timeout: 30_000 });
    // O histórico registra a passagem por UNKNOWN e a resolução por consulta (não por reenvio).
    await expect(unknown.getByText('Pagamento: Resultado desconhecido')).toBeVisible();
    await expect(unknown.getByText(/Autorização: Recusada.*consulta ao provedor/)).toBeVisible();
    await expect(unknown.getByRole('table').getByRole('row')).toHaveCount(2); // cabeçalho + uma única operação

    await page.goto(`/#/transacoes?customerId=${customer.code}`);
    await expect(page.getByRole('table', { name: 'Transações' }).getByRole('row')).toHaveCount(4); // cabeçalho + 3 pagamentos
  });

  test('6. erro da API é exibido e a tela se recupera sozinha', async ({ page }) => {
    await login(page);
    await page.goto(`/#/transacoes?customerId=${customer.code}`);
    await expect(page.getByRole('table', { name: 'Transações' })).toBeVisible();
    await page.route('**/admin/api/payments?**', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'indisponível', correlationId: 'e2e-falha' } }) }),
    );
    await expect(page.getByRole('alert').filter({ hasText: 'A API local não respondeu' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('table', { name: 'Transações' })).toBeVisible(); // dados anteriores mantidos
    await page.unroute('**/admin/api/payments?**');
    await expect(page.getByRole('alert').filter({ hasText: 'A API local não respondeu' })).toHaveCount(0, { timeout: 10_000 });
  });

  test('6b. tela sem atualização periódica também se recupera sozinha após falha da API', async ({ page }) => {
    await login(page);
    await page.route('**/admin/api/customers?**', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'indisponível', correlationId: 'e2e-falha' } }) }),
    );
    await page.goto('/#/clientes');
    await expect(page.getByRole('alert').filter({ hasText: 'A API local não respondeu' })).toBeVisible();
    await page.unroute('**/admin/api/customers?**');
    // Sem clicar em "Tentar agora": a nova tentativa automática traz a lista de volta.
    await expect(page.getByRole('alert').filter({ hasText: 'A API local não respondeu' })).toHaveCount(0, { timeout: 12_000 });
    await expect(page.getByRole('table', { name: 'Clientes' }).or(page.getByText('Nenhum cliente cadastrado'))).toBeVisible();
  });

  test('7. navegação responsiva em celular', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    const menu = page.getByRole('button', { name: 'Abrir menu' });
    await expect(menu).toBeVisible();
    await expect(page.locator('.rail a', { hasText: 'Transações' })).toBeHidden();
    // Menu fechado fora da ordem de foco: o Tab não pode cair em links invisíveis.
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.closest('.rail') !== null)).toBe(false);
    }
    await menu.click();
    await expect(page.getByRole('link', { name: 'Transações' })).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Abrir menu' })).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    await page.getByRole('link', { name: 'Transações' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Transações' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});
