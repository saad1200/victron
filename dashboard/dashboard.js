// Dashboard JavaScript for Solar Energy Monitoring
class SolarDashboard {
    constructor() {
        this.charts = {};
        this.currentData = null;
        this.init();
    }

    init() {
        // Set default dates to today
        const today = new Date();
        
        document.getElementById('startDate').value = this.formatDate(today);
        document.getElementById('endDate').value = this.formatDate(today);
        
        // Set comparison dates (previous 7 days)
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 7);
        
        document.getElementById('compareStart1').value = this.formatDate(weekAgo);
        document.getElementById('compareEnd1').value = this.formatDate(yesterday);
        document.getElementById('compareStart2').value = this.formatDate(today);
        document.getElementById('compareEnd2').value = this.formatDate(today);
        
        // Load initial dashboard
        this.loadDashboard();
    }

    setToday() {
        const today = new Date();
        document.getElementById('startDate').value = this.formatDate(today);
        document.getElementById('endDate').value = this.formatDate(today);
        this.loadDashboard();
    }

    setYesterday() {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        document.getElementById('startDate').value = this.formatDate(yesterday);
        document.getElementById('endDate').value = this.formatDate(yesterday);
        this.loadDashboard();
    }

    setLastDays() {
        const days = parseInt(document.getElementById('lastDays').value) || 7;
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days + 1); // Include today
        
        document.getElementById('startDate').value = this.formatDate(startDate);
        document.getElementById('endDate').value = this.formatDate(endDate);
        this.loadDashboard();
    }

    formatDate(date) {
        return date.toISOString().split('T')[0];
    }

    async loadDashboard() {
        try {
            this.showLoading();
            
            const startDate = document.getElementById('startDate').value;
            const endDate = document.getElementById('endDate').value;
            const period = document.getElementById('period').value;
            
            const response = await fetch(`/api/dashboard-data?start=${startDate}&end=${endDate}&period=${period}`);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            this.currentData = data;
            
            this.renderStats(data.summary);
            this.renderCharts(data);
            
        } catch (error) {
            console.error('Error loading dashboard:', error);
            this.showError('Failed to load dashboard data. Please check your connection and try again.');
        }
    }

    showLoading() {
        document.getElementById('statsGrid').innerHTML = `
            <div class="loading">
                <div class="spinner"></div>
                Loading dashboard data...
            </div>
        `;
    }

    showError(message) {
        document.getElementById('statsGrid').innerHTML = `
            <div class="error">
                <strong>Error:</strong> ${message}
            </div>
        `;
    }

    renderStats(summary) {
        const statsGrid = document.getElementById('statsGrid');
        
        // Calculate profit/loss
        const totalCost = summary.importCost;
        const totalEarnings = summary.exportEarnings;
        const netProfit = totalEarnings - totalCost;
        
        const stats = [
            {
                title: 'Total Energy Import',
                value: summary.totalImport?.toFixed(2) || '0.00',
                unit: 'kWh',
                class: 'negative'
            },
            {
                title: 'Total Energy Export',
                value: summary.totalExport?.toFixed(2) || '0.00',
                unit: 'kWh',
                class: 'positive'
            },
            {
                title: 'Solar Generation',
                value: summary.totalSolar?.toFixed(2) || '0.00',
                unit: 'kWh',
                class: 'positive'
            },
            {
                title: 'Import Cost',
                value: `$${(totalCost / 100)?.toFixed(2) || '0.00'}`,
                unit: '',
                class: 'negative'
            },
            {
                title: 'Export Earnings',
                value: `$${(totalEarnings / 100)?.toFixed(2) || '0.00'}`,
                unit: '',
                class: 'positive'
            },
            {
                title: 'Net Profit/Loss',
                value: `$${(netProfit / 100)?.toFixed(2) || '0.00'}`,
                unit: '',
                class: netProfit >= 0 ? 'positive' : 'negative'
            },
            {
                title: 'Battery Efficiency',
                value: summary.batteryEfficiency?.toFixed(1) || '0.0',
                unit: '%',
                class: 'neutral'
            },
            {
                title: 'Self Consumption',
                value: summary.selfConsumption?.toFixed(1) || '0.0',
                unit: '%',
                class: 'positive'
            }
        ];

        statsGrid.innerHTML = stats.map(stat => `
            <div class="stat-card">
                <h3>${stat.title}</h3>
                <div class="stat-value ${stat.class}">${stat.value}</div>
                <div class="stat-unit">${stat.unit}</div>
            </div>
        `).join('');
    }

    renderCharts(data) {
        this.renderEnergyChart(data.timeSeries);
        this.renderFinancialChart(data.financial);
        this.renderBatteryChart(data.battery);
        this.renderTariffChart(data.tariffBreakdown);
    }

    renderEnergyChart(timeSeries) {
        const ctx = document.getElementById('energyChart').getContext('2d');
        
        if (this.charts.energy) {
            this.charts.energy.destroy();
        }

        this.charts.energy = new Chart(ctx, {
            type: 'line',
            data: {
                labels: timeSeries.map(d => new Date(d.timestamp).toLocaleDateString()),
                datasets: [
                    {
                        label: 'Solar Generation',
                        data: timeSeries.map(d => d.solar),
                        borderColor: '#f59e0b',
                        backgroundColor: 'rgba(245, 158, 11, 0.1)',
                        fill: true,
                        tension: 0.4
                    },
                    {
                        label: 'Grid Import',
                        data: timeSeries.map(d => d.import),
                        borderColor: '#ef4444',
                        backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        fill: true,
                        tension: 0.4
                    },
                    {
                        label: 'Grid Export',
                        data: timeSeries.map(d => d.export),
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.1)',
                        fill: true,
                        tension: 0.4
                    },
                    {
                        label: 'Load Consumption',
                        data: timeSeries.map(d => d.load),
                        borderColor: '#6366f1',
                        backgroundColor: 'rgba(99, 102, 241, 0.1)',
                        fill: true,
                        tension: 0.4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                    },
                    title: {
                        display: true,
                        text: 'Energy Flow (kWh)'
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Energy (kWh)'
                        }
                    }
                }
            }
        });
    }

    renderFinancialChart(financial) {
        const ctx = document.getElementById('financialChart').getContext('2d');
        
        if (this.charts.financial) {
            this.charts.financial.destroy();
        }

        this.charts.financial = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: financial.map(d => new Date(d.date).toLocaleDateString()),
                datasets: [
                    {
                        label: 'Import Cost ($)',
                        data: financial.map(d => -(d.importCost / 100)),
                        backgroundColor: 'rgba(239, 68, 68, 0.8)',
                        borderColor: '#ef4444',
                        borderWidth: 1
                    },
                    {
                        label: 'Export Earnings ($)',
                        data: financial.map(d => d.exportEarnings / 100),
                        backgroundColor: 'rgba(16, 185, 129, 0.8)',
                        borderColor: '#10b981',
                        borderWidth: 1
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                    },
                    title: {
                        display: true,
                        text: 'Daily Financial Performance'
                    }
                },
                scales: {
                    y: {
                        title: {
                            display: true,
                            text: 'Amount ($)'
                        }
                    }
                }
            }
        });
    }

    renderBatteryChart(battery) {
        const ctx = document.getElementById('batteryChart').getContext('2d');
        
        if (this.charts.battery) {
            this.charts.battery.destroy();
        }

        this.charts.battery = new Chart(ctx, {
            type: 'line',
            data: {
                labels: battery.map(d => new Date(d.timestamp).toLocaleTimeString()),
                datasets: [
                    {
                        label: 'Battery SOC (%)',
                        data: battery.map(d => d.soc),
                        borderColor: '#8b5cf6',
                        backgroundColor: 'rgba(139, 92, 246, 0.1)',
                        fill: true,
                        tension: 0.4,
                        yAxisID: 'y'
                    },
                    {
                        label: 'Battery Power (kW)',
                        data: battery.map(d => d.power / 1000),
                        borderColor: '#06b6d4',
                        backgroundColor: 'rgba(6, 182, 212, 0.1)',
                        fill: false,
                        tension: 0.4,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                    },
                    title: {
                        display: true,
                        text: 'Battery Performance'
                    }
                },
                scales: {
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        title: {
                            display: true,
                            text: 'SOC (%)'
                        },
                        min: 0,
                        max: 100
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        title: {
                            display: true,
                            text: 'Power (kW)'
                        },
                        grid: {
                            drawOnChartArea: false,
                        },
                    }
                }
            }
        });
    }

    renderTariffChart(tariffData) {
        const ctx = document.getElementById('tariffChart').getContext('2d');
        
        if (this.charts.tariff) {
            this.charts.tariff.destroy();
        }

        const periods = ['Night', 'Day', 'PEAK', 'Evening'];
        const colors = ['#1e40af', '#f59e0b', '#dc2626', '#7c3aed'];

        this.charts.tariff = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: periods.map(p => `${p} (${(tariffData[p]?.profit / 100 || 0).toFixed(2)}$)`),
                datasets: [{
                    data: periods.map(p => Math.abs(tariffData[p]?.profit || 0)),
                    backgroundColor: colors,
                    borderWidth: 2,
                    borderColor: '#fff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                    },
                    title: {
                        display: true,
                        text: 'Profit/Loss by Tariff Period'
                    }
                }
            }
        });
    }

    async loadComparison() {
        try {
            const start1 = document.getElementById('compareStart1').value;
            const end1 = document.getElementById('compareEnd1').value;
            const start2 = document.getElementById('compareStart2').value;
            const end2 = document.getElementById('compareEnd2').value;

            const [response1, response2] = await Promise.all([
                fetch(`/api/dashboard-data?start=${start1}&end=${end1}&period=day`),
                fetch(`/api/dashboard-data?start=${start2}&end=${end2}&period=day`)
            ]);

            const data1 = await response1.json();
            const data2 = await response2.json();

            this.renderComparisonChart(data1, data2);

        } catch (error) {
            console.error('Error loading comparison:', error);
        }
    }

    renderComparisonChart(data1, data2) {
        const ctx = document.getElementById('comparisonChart').getContext('2d');
        
        if (this.charts.comparison) {
            this.charts.comparison.destroy();
        }

        const metrics = ['Total Import', 'Total Export', 'Solar Generation', 'Net Profit'];
        const period1Data = [
            data1.summary.totalImport,
            data1.summary.totalExport,
            data1.summary.totalSolar,
            (data1.summary.exportEarnings - data1.summary.importCost) / 100
        ];
        const period2Data = [
            data2.summary.totalImport,
            data2.summary.totalExport,
            data2.summary.totalSolar,
            (data2.summary.exportEarnings - data2.summary.importCost) / 100
        ];

        this.charts.comparison = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: metrics,
                datasets: [
                    {
                        label: 'Period 1',
                        data: period1Data,
                        backgroundColor: 'rgba(99, 102, 241, 0.8)',
                        borderColor: '#6366f1',
                        borderWidth: 1
                    },
                    {
                        label: 'Period 2',
                        data: period2Data,
                        backgroundColor: 'rgba(16, 185, 129, 0.8)',
                        borderColor: '#10b981',
                        borderWidth: 1
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'top',
                    },
                    title: {
                        display: true,
                        text: 'Period Comparison'
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Value'
                        }
                    }
                }
            }
        });
    }
}

// Global functions
function loadDashboard() {
    dashboard.loadDashboard();
}

function loadComparison() {
    dashboard.loadComparison();
}

// Initialize dashboard when page loads
let dashboard;
document.addEventListener('DOMContentLoaded', () => {
    dashboard = new SolarDashboard();
});
