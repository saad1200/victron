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
        
        // Calculate self-consumption savings
        this.calculateSelfConsumptionSavings(summary, this.currentData?.tariffBreakdown);
        
        // Reorganized widgets by logical grouping
        const stats = [
            // Energy Generation & Flow
            {
                title: 'Solar Generation',
                value: summary.totalSolar?.toFixed(2) || '0.00',
                unit: 'kWh',
                class: 'positive'
            },
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
            
            // Financial Performance
            {
                title: 'Import Cost',
                value: `£${(totalCost / 100)?.toFixed(2) || '0.00'}`,
                unit: '',
                class: 'negative'
            },
            {
                title: 'Export Earnings',
                value: `£${(totalEarnings / 100)?.toFixed(2) || '0.00'}`,
                unit: '',
                class: 'positive'
            },
            {
                title: 'Net Profit/Loss',
                value: `£${(netProfit / 100)?.toFixed(2) || '0.00'}`,
                unit: '',
                class: netProfit >= 0 ? 'positive' : 'negative'
            },
            
            // System Efficiency
            {
                title: 'Self Consumption Rate',
                value: summary.selfConsumption?.toFixed(1) || '0.0',
                unit: '%',
                class: 'positive'
            },
            {
                title: 'Battery Efficiency',
                value: summary.batteryEfficiency?.toFixed(1) || '0.0',
                unit: '%',
                class: 'neutral'
            },
            {
                title: 'Total Savings',
                value: (summary.selfConsumedSavings / 100)?.toFixed(2) || '0.00',
                unit: '£',
                class: 'positive'
            }
        ];

        statsGrid.innerHTML = stats.map(stat => `
            <div class="stat-card">
                <h3>${stat.title}</h3>
                <div class="stat-value ${stat.class}">${stat.value}<span class="stat-unit">${stat.unit}</span></div>
            </div>
        `).join('');
    }

    renderCharts(data) {
        this.renderEnergyChart(data.timeSeries);
        this.renderFinancialChart(data.financial);
        this.renderBatteryChart(data.battery);
        this.renderTariffChart(data.tariffBreakdown);
        console.log('PV Arrays data from API:', data.tariffBreakdown?.pvArrays);
        this.updatePvArraysChart(data.tariffBreakdown?.pvArrays || []);
        SolarDashboard.updateArrayGenerationChart(data.tariffBreakdown?.pvArrays || []);
        this.calculateSelfConsumptionSavings(data.summary, data.tariffBreakdown);
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

        // Handle the breakdown array from API response
        const breakdown = tariffData.breakdown || [];
        if (breakdown.length === 0) {
            return; // Skip rendering if no data
        }

        const colors = ['#1e40af', '#f59e0b', '#dc2626', '#7c3aed'];

        this.charts.tariff = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: breakdown.map(item => `${item.period} (£${(item.profit / 100).toFixed(2)})`),
                datasets: [{
                    data: breakdown.map(item => Math.abs(item.profit)),
                    backgroundColor: colors.slice(0, breakdown.length),
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

    updatePvArraysChart(pvArrays) {
        const ctx = document.getElementById('pvArraysChart').getContext('2d');
        
        if (this.pvArraysChart) {
            this.pvArraysChart.destroy();
        }
        
        if (pvArrays.length === 0) {
            // Show message when no data
            ctx.font = '16px Arial';
            ctx.textAlign = 'center';
            ctx.fillStyle = '#666';
            ctx.fillText('No PV array data available for selected date range', ctx.canvas.width / 2, ctx.canvas.height / 2);
            return;
        }
        
        // Physical panel layout mapping
        const arrayInfo = {
            0: { location: 'North House Roof', panels: 10, orientation: 'North' },
            1: { location: 'South House Roof', panels: 11, orientation: 'South' },
            2: { location: 'Garage Roof', panels: 4, orientation: 'South' },
            3: { location: 'Ground Mount', panels: 7, orientation: 'South' }
        };
        
        // Calculate efficiency (W per panel)
        const enhancedData = pvArrays.map(array => {
            const info = arrayInfo[array.arrayId] || { location: `Array ${array.arrayId}`, panels: 1, orientation: 'Unknown' };
            return {
                ...array,
                ...info,
                avgWPerPanel: array.avgPower / info.panels,
                maxWPerPanel: array.maxPower / info.panels,
                efficiency: (array.avgPower / (info.panels * 400)) * 100 // Assuming 400W panels
            };
        });
        
        this.pvArraysChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: enhancedData.map(array => `Array ${array.arrayId}`),
                datasets: [{
                    label: 'Average Power (W)',
                    data: enhancedData.map(array => array.avgPower),
                    backgroundColor: 'rgba(34, 197, 94, 0.8)',
                    borderColor: 'rgba(34, 197, 94, 1)',
                    borderWidth: 1,
                    yAxisID: 'y'
                }, {
                    label: 'Max Power (W)',
                    data: enhancedData.map(array => array.maxPower),
                    backgroundColor: 'rgba(249, 115, 22, 0.8)',
                    borderColor: 'rgba(249, 115, 22, 1)',
                    borderWidth: 1,
                    yAxisID: 'y'
                }, {
                    label: 'Efficiency (%)',
                    data: enhancedData.map(array => array.efficiency),
                    backgroundColor: 'rgba(99, 102, 241, 0.8)',
                    borderColor: 'rgba(99, 102, 241, 1)',
                    borderWidth: 1,
                    type: 'line',
                    yAxisID: 'y1'
                }]
            },
            options: {
                responsive: true,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                scales: {
                    x: {
                        display: true,
                        title: {
                            display: true,
                            text: 'Solar Array Location'
                        }
                    },
                    y: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Power (W)'
                        }
                    },
                    y1: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        beginAtZero: true,
                        max: 100,
                        title: {
                            display: true,
                            text: 'Efficiency (%)'
                        },
                        grid: {
                            drawOnChartArea: false,
                        },
                    }
                },
                plugins: {
                    title: {
                        display: true,
                        text: 'Solar Array Performance - 32 Panels Total',
                        font: {
                            size: 16
                        }
                    },
                    legend: {
                        display: true,
                        position: 'top'
                    },
                    tooltip: {
                        callbacks: {
                            title: function(context) {
                                const array = enhancedData[context[0].dataIndex];
                                return `Array ${array.arrayId} - ${array.location}`;
                            },
                            afterLabel: function(context) {
                                const array = enhancedData[context.dataIndex];
                                return [
                                    `Location: ${array.location}`,
                                    `Panels: ${array.panels} (${array.orientation} facing)`,
                                    `Avg W/panel: ${array.avgWPerPanel.toFixed(1)}W`,
                                    `Max W/panel: ${array.maxWPerPanel.toFixed(1)}W`,
                                    `Readings: ${array.readings}`
                                ];
                            }
                        }
                    }
                }
            }
        });
    }

    static updateArrayGenerationChart(pvArrays) {
        const ctx = document.getElementById('arrayGenerationChart').getContext('2d');
        
        console.log('updateArrayGenerationChart called with:', pvArrays);
        
        if (!pvArrays || pvArrays.length === 0) {
            // Show message when no data
            ctx.font = '16px Arial';
            ctx.textAlign = 'center';
            ctx.fillStyle = '#666';
            ctx.fillText('No PV array data available for selected date range', ctx.canvas.width / 2, ctx.canvas.height / 2);
            return;
        }

        // Physical panel layout mapping
        const arrayInfo = {
            0: { location: 'North House Roof', panels: 10, orientation: 'North' },
            1: { location: 'South House Roof', panels: 11, orientation: 'South' },
            2: { location: 'Garage Roof', panels: 4, orientation: 'South' },
            3: { location: 'Ground Mount', panels: 7, orientation: 'South' }
        };

        // Calculate total generation (kWh) for each array
        const enhancedData = pvArrays.map(array => {
            const info = arrayInfo[array.arrayId] || { location: `Array ${array.arrayId}`, panels: 1, orientation: 'Unknown' };
            // Estimate daily generation: avgPower * hours of sunlight (assume 8 hours average)
            const estimatedDailyKwh = (array.avgPower * 8) / 1000;
            return {
                ...array,
                ...info,
                estimatedDailyKwh,
                avgWPerPanel: array.avgPower / info.panels
            };
        });

        if (this.arrayGenerationChart) {
            this.arrayGenerationChart.destroy();
        }

        this.arrayGenerationChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: enhancedData.map(array => `Array ${array.arrayId}`),
                datasets: [{
                    label: 'Estimated Daily Generation (kWh)',
                    data: enhancedData.map(array => array.estimatedDailyKwh),
                    backgroundColor: [
                        'rgba(59, 130, 246, 0.8)',  // Blue for Array 0
                        'rgba(34, 197, 94, 0.8)',   // Green for Array 1
                        'rgba(251, 191, 36, 0.8)',  // Yellow for Array 2
                        'rgba(239, 68, 68, 0.8)'    // Red for Array 3
                    ],
                    borderColor: [
                        'rgba(59, 130, 246, 1)',
                        'rgba(34, 197, 94, 1)',
                        'rgba(251, 191, 36, 1)',
                        'rgba(239, 68, 68, 1)'
                    ],
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: {
                        display: true,
                        text: 'Daily Generation Distribution by Array',
                        font: {
                            size: 16
                        }
                    },
                    legend: {
                        display: true,
                        position: 'bottom'
                    },
                    tooltip: {
                        callbacks: {
                            title: function(context) {
                                const array = enhancedData[context[0].dataIndex];
                                return `Array ${array.arrayId} - ${array.location}`;
                            },
                            label: function(context) {
                                const array = enhancedData[context.dataIndex];
                                const percentage = ((array.estimatedDailyKwh / enhancedData.reduce((sum, a) => sum + a.estimatedDailyKwh, 0)) * 100).toFixed(1);
                                return [
                                    `Est. Daily: ${array.estimatedDailyKwh.toFixed(2)} kWh (${percentage}%)`,
                                    `Avg Power: ${array.avgPower.toFixed(0)}W`,
                                    `W/Panel: ${array.avgWPerPanel.toFixed(1)}W`,
                                    `${array.panels} panels (${array.orientation})`
                                ];
                            }
                        }
                    }
                }
            }
        });
    }

    calculateSelfConsumptionSavings(summary, tariffBreakdown) {
        console.log('calculateSelfConsumptionSavings called with:', summary, tariffBreakdown);
        console.log('tariffBreakdown.breakdown:', tariffBreakdown?.breakdown);
        
        // Tariff rates in pence per kWh
        const TARIFF_RATES = {
            'Day': 31.488,
            'Night': 14.877,
            'Evening': 31.488,
            'Peak': 31.488,
            'PEAK': 31.488  // Handle uppercase variant
        };
        
        // Calculate self-consumed energy
        const totalSolar = summary.totalSolar || 0;
        const totalExport = summary.totalExport || 0;
        const selfConsumedEnergy = Math.max(0, totalSolar - totalExport);
        
        // Calculate self-consumption rate
        const selfConsumptionRate = totalSolar > 0 ? (selfConsumedEnergy / totalSolar) * 100 : 0;
        
        // Calculate total savings using actual tariff breakdown if available
        let totalSavings = 0;
        let periodBreakdowns = [];
        
        if (tariffBreakdown && tariffBreakdown.breakdown) {
            // Use actual tariff period data
            periodBreakdowns = tariffBreakdown.breakdown.map(period => {
                const rate = TARIFF_RATES[period.period] || 31.488;
                const selfConsumed = Math.max(0, (period.import + period.export) - period.export);
                const savings = selfConsumed * (rate / 100);
                totalSavings += savings;
                
                const result = {
                    period: period.period,
                    import: period.import,
                    export: period.export,
                    selfConsumed: selfConsumed,
                    savings: savings,
                    rate: rate,
                    profit: period.profit / 100, // Convert from pence to pounds
                    importCost: period.importCost / 100,
                    exportEarnings: period.exportEarnings / 100
                };
                console.log(`Period ${period.period} breakdown:`, result);
                return result;
            });
        } else {
            // Fallback calculation
            const dayConsumption = selfConsumedEnergy * 0.7;
            const nightConsumption = selfConsumedEnergy * 0.3;
            const daySavings = dayConsumption * (TARIFF_RATES.Day / 100);
            const nightSavings = nightConsumption * (TARIFF_RATES.Night / 100);
            totalSavings = daySavings + nightSavings;
        }
        
        // Update the main UI elements with new field names and data from API
        const solarDirectUseElement = document.getElementById('solarDirectUse');
        const batteryDischargeUsedElement = document.getElementById('batteryDischargeUsed');
        const gridCostAvoidedElement = document.getElementById('gridCostAvoided');
        const selfConsumptionRateElement = document.getElementById('selfConsumptionRate');
        
        // Update battery panel elements
        const batteryChargedFromSolarElement = document.getElementById('batteryChargedFromSolar');
        const batteryChargedFromGridElement = document.getElementById('batteryChargedFromGrid');
        const gridChargingCostElement = document.getElementById('gridChargingCost');
        const gridToPeakProfitElement = document.getElementById('gridToPeakProfit');
        
        if (solarDirectUseElement && tariffBreakdown) {
            solarDirectUseElement.textContent = `${tariffBreakdown.directSolarConsumption?.toFixed(2) || '0.00'} kWh`;
        }
        
        if (batteryDischargeUsedElement && tariffBreakdown) {
            batteryDischargeUsedElement.textContent = `${tariffBreakdown.batteryConsumption?.toFixed(2) || '0.00'} kWh`;
        }
        
        if (gridCostAvoidedElement && tariffBreakdown) {
            const savings = tariffBreakdown.selfConsumedSavings || 0;
            gridCostAvoidedElement.textContent = `£${(savings / 100).toFixed(2)}`;
        }
        
        if (selfConsumptionRateElement && summary) {
            const rate = summary.selfConsumption || 0;
            selfConsumptionRateElement.textContent = `${rate.toFixed(1)}%`;
        }
        
        if (batteryChargedFromSolarElement && tariffBreakdown) {
            const solarCharged = tariffBreakdown.batteryChargedFromSolar || 0;
            batteryChargedFromSolarElement.textContent = `${solarCharged.toFixed(2)} kWh`;
        }
        
        if (batteryChargedFromGridElement && tariffBreakdown) {
            const gridCharged = tariffBreakdown.batteryChargedFromGrid || 0;
            batteryChargedFromGridElement.textContent = `${gridCharged.toFixed(2)} kWh`;
        }
        
        if (gridChargingCostElement && tariffBreakdown) {
            const cost = tariffBreakdown.gridChargingCost || 0;
            gridChargingCostElement.textContent = `£${(cost / 100).toFixed(2)}`;
        }
        
        if (gridToPeakProfitElement && tariffBreakdown) {
            const profit = tariffBreakdown.gridToPeakProfit || 0;
            gridToPeakProfitElement.textContent = `£${(profit / 100).toFixed(2)}`;
        }

        // Update daily targets panel
        this.updateDailyTargets(tariffBreakdown);
        
        // Update detailed period breakdown
        this.updateTariffPeriodBreakdown(periodBreakdowns);
        
        // Store for potential future use
        this.selfConsumptionData = {
            selfConsumedEnergy,
            totalSavings,
            selfConsumptionRate,
            periodBreakdowns
        };
    }
    
    updateTariffPeriodBreakdown(periodBreakdowns) {
        const container = document.getElementById('tariffPeriodBreakdown');
        if (!container || !periodBreakdowns.length) return;
        
        const periodColors = {
            'Day': { bg: 'linear-gradient(135deg, #fef3c7, #fde68a)', border: '#f59e0b', text: '#92400e' },
            'Night': { bg: 'linear-gradient(135deg, #e0e7ff, #c7d2fe)', border: '#6366f1', text: '#3730a3' },
            'Evening': { bg: 'linear-gradient(135deg, #fce7f3, #fbcfe8)', border: '#ec4899', text: '#be185d' },
            'Peak': { bg: 'linear-gradient(135deg, #fee2e2, #fecaca)', border: '#ef4444', text: '#dc2626' },
            'PEAK': { bg: 'linear-gradient(135deg, #fee2e2, #fecaca)', border: '#ef4444', text: '#dc2626' }
        };
        
        container.innerHTML = periodBreakdowns.map(period => {
            const colors = periodColors[period.period] || periodColors['Day'];
            return `
                <div style="background: ${colors.bg}; border-radius: 10px; padding: 15px; border-left: 4px solid ${colors.border};">
                    <h5 style="color: ${colors.text}; margin-bottom: 10px; font-size: 0.9rem; font-weight: 600; text-transform: uppercase;">${period.period} Period</h5>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 0.85rem;">
                        <div><strong>Import:</strong> ${period.import.toFixed(2)} kWh</div>
                        <div><strong>Export:</strong> ${period.export.toFixed(2)} kWh</div>
                        <div><strong>Self-Used:</strong> ${period.selfConsumed.toFixed(2)} kWh</div>
                        <div><strong>Rate:</strong> ${period.rate.toFixed(3)}p/kWh</div>
                        <div><strong>Import Cost:</strong> £${period.importCost.toFixed(2)}</div>
                        <div><strong>Export Earn:</strong> £${period.exportEarnings.toFixed(2)}</div>
                        <div style="grid-column: 1 / -1; margin-top: 5px; padding-top: 8px; border-top: 1px solid rgba(0,0,0,0.1);">
                            <strong>Savings:</strong> £${period.savings.toFixed(2)} | 
                            <strong>Net Profit:</strong> <span style="color: ${period.profit >= 0 ? '#059669' : '#dc2626'};">£${period.profit.toFixed(2)}</span>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    updateDailyTargets(tariffBreakdown) {
        if (!tariffBreakdown) return;

        const DAILY_TARGET = 700; // £7.00 in pence

        // Update main target metrics
        const batteryArbitrageProfitElement = document.getElementById('batteryArbitrageProfit');
        const solarBatterySavingsElement = document.getElementById('solarBatterySavings');
        const totalDailySavingsElement = document.getElementById('totalDailySavings');
        const targetPercentageElement = document.getElementById('targetPercentage');
        const targetStatusElement = document.getElementById('targetStatus');
        const targetPerformanceCard = document.getElementById('targetPerformanceCard');

        // Update main target metrics including grid import cost widget
        const totalGridImportKwhElement = document.getElementById('totalGridImportKwh');
        const totalGridImportCostElement = document.getElementById('totalGridImportCost');

        if (batteryArbitrageProfitElement && tariffBreakdown.batteryArbitrageProfit !== undefined) {
            const profit = tariffBreakdown.batteryArbitrageProfit || 0;
            const peakExportEarnings = tariffBreakdown.peakExportEarnings || 0;
            const nightImportCost = tariffBreakdown.nightImportCost || 0;
            
            batteryArbitrageProfitElement.textContent = `£${(profit / 100).toFixed(2)}`;
            
            // Update breakdown display
            const breakdownElement = document.getElementById('batteryArbitrageProfitBreakdown');
            if (breakdownElement) {
                breakdownElement.textContent = `£${(peakExportEarnings / 100).toFixed(2)} peak export - £${(nightImportCost / 100).toFixed(2)} night import`;
            }
        }

        if (solarBatterySavingsElement && tariffBreakdown.solarBatterySavings !== undefined) {
            const savings = tariffBreakdown.solarBatterySavings || 0;
            const solarDirect = tariffBreakdown.directSolarConsumption || 0;
            const batteryDischarge = tariffBreakdown.batteryConsumption || 0;
            
            solarBatterySavingsElement.textContent = `£${(savings / 100).toFixed(2)}`;
            
            // Update breakdown display
            const breakdownElement = document.getElementById('solarBatterySavingsBreakdown');
            if (breakdownElement) {
                breakdownElement.textContent = `${solarDirect.toFixed(2)} kWh solar + ${batteryDischarge.toFixed(2)} kWh battery × £0.34`;
            }
        }

        if (totalGridImportKwhElement && tariffBreakdown.totalGridImportKwh !== undefined) {
            const importKwh = tariffBreakdown.totalGridImportKwh || 0;
            totalGridImportKwhElement.textContent = `${importKwh.toFixed(2)} kWh`;
        }

        if (totalGridImportCostElement && tariffBreakdown.totalGridImportCost !== undefined) {
            const importCost = tariffBreakdown.totalGridImportCost || 0;
            totalGridImportCostElement.textContent = `£${(importCost / 100).toFixed(2)}`;
        }

        if (totalDailySavingsElement && tariffBreakdown.totalDailySavings !== undefined) {
            const totalSavings = tariffBreakdown.totalDailySavings || 0;
            const solarBatterySavings = tariffBreakdown.solarBatterySavings || 0;
            const arbitrageProfit = tariffBreakdown.batteryArbitrageProfit || 0;
            const importCost = tariffBreakdown.totalGridImportCost || 0;
            
            totalDailySavingsElement.textContent = `£${(totalSavings / 100).toFixed(2)}`;
            
            // Update breakdown calculation display
            const breakdownElement = document.getElementById('totalDailySavingsBreakdown');
            if (breakdownElement) {
                breakdownElement.textContent = `£${(solarBatterySavings / 100).toFixed(2)} + £${(arbitrageProfit / 100).toFixed(2)} - £${(importCost / 100).toFixed(2)}`;
            }
            
            // Update color based on positive/negative savings
            if (totalSavings >= 0) {
                totalDailySavingsElement.className = 'stat-value positive';
            } else {
                totalDailySavingsElement.className = 'stat-value negative';
            }

            // Calculate target percentage
            const targetPercentage = (totalSavings / DAILY_TARGET) * 100;
            
            if (targetPercentageElement) {
                targetPercentageElement.textContent = `${targetPercentage.toFixed(1)}%`;
            }

            // Update target calculation display
            const targetCalculationElement = document.getElementById('targetCalculation');
            if (targetCalculationElement) {
                targetCalculationElement.textContent = `£${(totalSavings / 100).toFixed(2)} of £7.00 target`;
            }

            // Update target status and card styling
            if (targetStatusElement && targetPerformanceCard) {
                if (targetPercentage >= 100) {
                    targetStatusElement.textContent = 'Target Achieved! 🎉';
                    targetPerformanceCard.style.background = 'linear-gradient(135deg, #dcfce7, #bbf7d0)';
                    targetPerformanceCard.style.borderLeft = '4px solid #10b981';
                    targetPercentageElement.style.color = '#065f46';
                    targetStatusElement.style.color = '#065f46';
                } else if (targetPercentage >= 80) {
                    targetStatusElement.textContent = 'Close to Target';
                    targetPerformanceCard.style.background = 'linear-gradient(135deg, #fef3c7, #fde68a)';
                    targetPerformanceCard.style.borderLeft = '4px solid #f59e0b';
                    targetPercentageElement.style.color = '#92400e';
                    targetStatusElement.style.color = '#92400e';
                } else {
                    targetStatusElement.textContent = 'Below Target';
                    targetPerformanceCard.style.background = 'linear-gradient(135deg, #fee2e2, #fecaca)';
                    targetPerformanceCard.style.borderLeft = '4px solid #ef4444';
                    targetPercentageElement.style.color = '#991b1b';
                    targetStatusElement.style.color = '#991b1b';
                }
            }
        }

        // Update 7-day breakdown
        this.updateDailyBreakdown(tariffBreakdown.dailyBreakdown || []);
    }

    updateDailyBreakdown(dailyBreakdown) {
        const dailyBreakdownGrid = document.getElementById('dailyBreakdownGrid');
        if (!dailyBreakdownGrid || !dailyBreakdown.length) return;

        const last7Days = dailyBreakdown.slice(-7); // Get last 7 days

        dailyBreakdownGrid.innerHTML = last7Days.map(day => {
            const date = new Date(day.date);
            const dayName = date.toLocaleDateString('en-GB', { weekday: 'short' });
            const dayDate = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
            const percentage = day.targetPercentage || 0;
            
            let cardStyle, textColor;
            if (percentage >= 100) {
                cardStyle = 'background: linear-gradient(135deg, #dcfce7, #bbf7d0); border-left: 4px solid #10b981;';
                textColor = '#065f46';
            } else if (percentage >= 80) {
                cardStyle = 'background: linear-gradient(135deg, #fef3c7, #fde68a); border-left: 4px solid #f59e0b;';
                textColor = '#92400e';
            } else {
                cardStyle = 'background: linear-gradient(135deg, #fee2e2, #fecaca); border-left: 4px solid #ef4444;';
                textColor = '#991b1b';
            }

            return `
                <div class="savings-card" style="${cardStyle} border-radius: 8px; padding: 12px; text-align: center;">
                    <div style="font-size: 0.75rem; color: #6b7280; margin-bottom: 4px;">${dayName}</div>
                    <div style="font-size: 0.7rem; color: #6b7280; margin-bottom: 8px;">${dayDate}</div>
                    <div style="font-size: 1.2rem; font-weight: 700; color: ${textColor};">${percentage.toFixed(0)}%</div>
                    <div style="font-size: 0.65rem; color: ${textColor}; margin-top: 4px;">£${(day.totalSavings / 100).toFixed(2)}</div>
                </div>
            `;
        }).join('');
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
