import React from 'react';
import { render, screen } from '@testing-library/react';
import { PortfolioSummaryCard } from './PortfolioSummaryCard';
import type { HoldingsResult } from '@/lib/holdings';

function makeHoldings(totalDividends: number): HoldingsResult {
  return {
    holdings: [{
      stockId: 's1',
      ticker: 'BDO',
      name: 'BDO Unibank',
      shares: 10,
      avgCostPerShare: 100,
      totalCost: 1000,
      currentPrice: 110,
      marketValue: 1100,
      unrealizedGainLoss: 100,
      unrealizedGainLossPct: 10,
    }],
    totalCost: 1000,
    totalMarketValue: 1100,
    totalUnrealizedGainLoss: 100,
    totalUnrealizedGainLossPct: 10,
    totalRealizedGainLoss: 0,
    totalDividends,
  };
}

describe('PortfolioSummaryCard', () => {
  test('updates dividends when holdings prop changes', () => {
    const { rerender } = render(<PortfolioSummaryCard holdings={makeHoldings(12.34)} />);

    expect(screen.getByText('₱12.34')).toBeTruthy();

    rerender(<PortfolioSummaryCard holdings={makeHoldings(56.78)} />);

    expect(screen.queryByText('₱12.34')).toBeNull();
    expect(screen.getByText('₱56.78')).toBeTruthy();
  });

  test('renders nothing without holdings data or rows', () => {
    const { container, rerender } = render(<PortfolioSummaryCard holdings={null} />);

    expect(container.firstChild).toBeNull();

    rerender(<PortfolioSummaryCard holdings={{ ...makeHoldings(12.34), holdings: [] }} />);

    expect(container.firstChild).toBeNull();
  });
});
