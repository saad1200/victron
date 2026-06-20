// New Octopus Energy Dashboard JavaScript
class OctopusDashboard {
    constructor() {
        this.chart = null;
        this.currentData = null;
        this.currentView = 'table';
        this.init();
    }

    init() {
        // Load initial dashboard
        this.loadDashboard();
    }

    async loadDashboard() {
        try {
            this.showLoading();
            
            const range = document.getElementById('rangeFilter').value;
            const groupBy = document.getElementById('groupByFilter').value;
            
            console.log(`Loading dashboard data: range=${range}, groupBy=${groupBy}`);
            
            const response = await fetch(`/api/dashboard-data?range=${range}&groupBy=${groupBy}`);
            
            console.log('Response status:', response.status);
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error('Server response:', errorText);
                throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
            }
            
            const data = await response.json();
            console.log('Dashboard data received:', data);
            this.currentData = data;
            
            this.renderSummary(data.summary);
            this.renderTable(data.timeSeries);
            
            if (this.currentView === 'chart') {
                this.renderChart(data.timeSeries);
            }
            
        } catch (error) {
            console.error('Error loading dashboard:', error);
            this.showError(`Failed to load dashboard data: ${error.message}. Please check the browser console for details.`);
        }
    }

    showLoading() {
        document.getElementById('summaryGrid').innerHTML = `
            <div class="loading">
                <div class="spinner"></div>
                Loading summary data...
            </div>
        `;
        
        document.getElementById('energyTableBody').innerHTML = `
            <tr>
                <td colspan="9" class="loading">
                    <div class="spinner"></div>
                    Loading energy data...
                </td>
            </tr>
        `;
    }

    showError(message) {
        document.getElementById('summaryGrid').innerHTML = `
            <div class="error">
                <strong>Error:</strong> ${message}
            </div>
        `;
        
        document.getElementById('energyTableBody').innerHTML = `
            <tr>
                <td colspan="9" class="error">
                    <strong>Error:</strong> ${message}
                </td>
            </tr>
        `;
    }

    renderSummary(summary) {
        const summaryGrid = document.getElementById('summaryGrid');
        
        const summaryCards = [
            {
                label: 'Total Imported',
                value: `${summary.totalImported?.toFixed(2) || '0.00'} kWh`,
                class: 'negative'
            },
            {
                label: 'Total Exported',
                value: `${summary.totalExported?.toFixed(2) || '0.00'} kWh`,
                class: 'positive'
            },
            {
                label: 'Import Cost',
                value: `£${summary.totalImportCost?.toFixed(2) || '0.00'}`,
                class: 'negative'
            },
            {
                label: 'Export Earnings',
                value: `£${summary.totalExportEarnings?.toFixed(2) || '0.00'}`,
                class: 'positive'
            },
            {
                label: 'Standing Charges',
                value: `£${summary.totalStandingCharges?.toFixed(2) || '0.00'}`,
                class: 'neutral'
            },
            {
                label: 'Net Profit/Loss',
                value: `£${summary.netProfit?.toFixed(2) || '0.00'}`,
                class: summary.netProfit >= 0 ? 'positive' : 'negative'
            },
            {
                label: 'Avg Import Rate',
                value: `${summary.avgImportRate?.toFixed(2) || '0.00'}p/kWh`,
                class: 'neutral'
            },
            {
                label: 'Avg Export Rate',
                value: `${summary.avgExportRate?.toFixed(2) || '0.00'}p/kWh`,
                class: 'neutral'
            }
        ];

        summaryGrid.innerHTML = summaryCards.map(card => `
            <div class="summary-card ${card.class}">
                <div class="summary-value ${card.class}">${card.value}</div>
                <div class="summary-label">${card.label}</div>
            </div>
        `).join('');
    }

    renderTable(timeSeries) {
        const tableBody = document.getElementById('energyTableBody');
        
        if (!timeSeries || timeSeries.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="10" style="text-align: center; padding: 20px; color: #666;">
                        No data available for the selected period
                    </td>
                </tr>
            `;
            return;
        }

        tableBody.innerHTML = timeSeries.map(row => {
            const netCostClass = row.netCost >= 0 ? 'negative' : 'positive';
            const profitClass = row.exportEarnings >= row.importCost ? 'positive' : 'negative';
            
            return `
                <tr>
                    <td>${this.formatPeriod(row.period)}</td>
                    <td>${row.productName || 'Unknown'}</td>
                    <td>£${row.standingCharge?.toFixed(2) || '0.00'}</td>
                    <td>${row.importedKwh?.toFixed(2) || '0.00'}</td>
                    <td>${row.avgImportRate?.toFixed(2) || '0.00'}p</td>
                    <td>£${row.importCost?.toFixed(2) || '0.00'}</td>
                    <td>${row.exportedKwh?.toFixed(2) || '0.00'}</td>
                    <td>${row.avgExportRate?.toFixed(2) || '0.00'}p</td>
                    <td class="${profitClass}">£${row.exportEarnings?.toFixed(2) || '0.00'}</td>
                    <td class="${netCostClass}">£${row.netCost?.toFixed(2) || '0.00'}</td>
                </tr>
            `;
        }).join('');
    }

    renderChart(timeSeries) {
        const ctx = document.getElementById('energyChart').getContext('2d');
        
        if (this.chart) {
            this.chart.destroy();
        }

        if (!timeSeries || timeSeries.length === 0) {
            ctx.font = '16px Arial';
            ctx.textAlign = 'center';
            ctx.fillStyle = '#666';
            ctx.fillText('No data available for the selected period', ctx.canvas.width / 2, ctx.canvas.height / 2);
            return;
        }

        const labels = timeSeries.map(item => this.formatPeriod(item.period));
        
        this.chart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Import Cost (£)',
                        data: timeSeries.map(item => item.importCost),
                        backgroundColor: 'rgba(239, 68, 68, 0.8)',
                        borderColor: '#ef4444',
                        borderWidth: 1,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Export Earnings (£)',
                        data: timeSeries.map(item => item.exportEarnings),
                        backgroundColor: 'rgba(16, 185, 129, 0.8)',
                        borderColor: '#10b981',
                        borderWidth: 1,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Net Cost (£)',
                        data: timeSeries.map(item => item.netCost),
                        backgroundColor: timeSeries.map(item => 
                            item.netCost >= 0 ? 'rgba(239, 68, 68, 0.6)' : 'rgba(16, 185, 129, 0.6)'
                        ),
                        borderColor: timeSeries.map(item => 
                            item.netCost >= 0 ? '#ef4444' : '#10b981'
                        ),
                        borderWidth: 2,
                        type: 'line',
                        yAxisID: 'y1',
                        tension: 0.4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    title: {
                        display: true,
                        text: 'Energy Import, Export & Net Cost Analysis'
                    },
                    legend: {
                        position: 'top',
                    },
                    tooltip: {
                        callbacks: {
                            afterLabel: function(context) {
                                const dataIndex = context.dataIndex;
                                const item = timeSeries[dataIndex];
                                return [
                                    `Imported: ${item.importedKwh?.toFixed(2)} kWh`,
                                    `Exported: ${item.exportedKwh?.toFixed(2)} kWh`,
                                    `Import Rate: ${item.avgImportRate?.toFixed(2)}p/kWh`,
                                    `Export Rate: ${item.avgExportRate?.toFixed(2)}p/kWh`,
                                    `Standing Charge: £${item.standingCharge?.toFixed(2)}`
                                ];
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        display: true,
                        title: {
                            display: true,
                            text: 'Period'
                        }
                    },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Cost/Earnings (£)'
                        }
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        title: {
                            display: true,
                            text: 'Net Cost (£)'
                        },
                        grid: {
                            drawOnChartArea: false,
                        },
                    }
                }
            }
        });
    }

    showView(viewType) {
        this.currentView = viewType;
        
        // Update toggle buttons
        document.getElementById('tableToggle').classList.toggle('active', viewType === 'table');
        document.getElementById('chartToggle').classList.toggle('active', viewType === 'chart');
        
        // Show/hide views
        document.getElementById('tableView').style.display = viewType === 'table' ? 'block' : 'none';
        document.getElementById('chartView').style.display = viewType === 'chart' ? 'block' : 'none';
        
        // Render chart if switching to chart view
        if (viewType === 'chart' && this.currentData) {
            this.renderChart(this.currentData.timeSeries);
        }
    }

    formatPeriod(period) {
        const date = new Date(period);
        const groupBy = document.getElementById('groupByFilter').value;
        
        switch (groupBy) {
            case 'hour':
                return date.toLocaleString('en-GB', { 
                    month: 'short', 
                    day: 'numeric', 
                    hour: '2-digit',
                    minute: '2-digit'
                });
            case 'day':
                return date.toLocaleDateString('en-GB', { 
                    weekday: 'short',
                    month: 'short', 
                    day: 'numeric' 
                });
            case 'week':
                const weekEnd = new Date(date);
                weekEnd.setDate(date.getDate() + 6);
                return `${date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}`;
            case 'month':
                return date.toLocaleDateString('en-GB', { 
                    year: 'numeric',
                    month: 'long' 
                });
            default:
                return date.toLocaleDateString('en-GB');
        }
    }
}

// Initialize dashboard when page loads
const dashboard = new OctopusDashboard();
