'use client';

import { useEffect, useState } from 'react';
import RealTimeWorkerView from '../../(protected)/tasks/[id]/RealTimeWorkerView';
import { mockWorkers, type FixtureState } from './fixtures-data';

export default function DevFixturesPage() {
    // Read the selected state from the URL after mount. Doing this during render
    // (typeof window checks) diverges between the server and client and causes a
    // hydration mismatch, so start from the default and sync on the client.
    const [state, setState] = useState<FixtureState>('waiting-input');

    useEffect(() => {
        const param = new URLSearchParams(window.location.search).get('state');
        if (param && param in mockWorkers) setState(param as FixtureState);
    }, []);

    const worker = mockWorkers[state] || mockWorkers['waiting-input'];

    return (
        <div className="min-h-screen bg-surface-1 p-8">
            <div className="max-w-4xl mx-auto">
                <div className="mb-6">
                    <h1 className="text-2xl font-bold mb-2">Dev Fixtures: Worker States</h1>
                    <p className="text-text-secondary mb-4">
                        Use these fixtures to test UI components in isolation without database dependencies.
                    </p>

                    {/* State selector */}
                    <div className="flex gap-2 flex-wrap">
                        {Object.keys(mockWorkers).map((s) => (
                            <a
                                key={s}
                                href={`?state=${s}`}
                                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${state === s
                                    ? 'bg-primary text-white'
                                    : 'bg-surface-3 text-text-secondary hover:bg-surface-4'
                                    }`}
                            >
                                {s}
                            </a>
                        ))}
                    </div>
                </div>

                <div className="bg-surface-2 rounded-xl shadow-lg p-6">
                    <h2 className="text-lg font-semibold mb-4">
                        Active Worker: <span className="text-primary">{state}</span>
                    </h2>
                    <RealTimeWorkerView
                        initialWorker={worker as any}
                        statusColors={{
                            pending: 'bg-status-warning/10 text-status-warning',
                            assigned: 'bg-status-info/10 text-status-info',
                            running: 'bg-status-success/10 text-status-success',
                            waiting_input: 'bg-status-running/10 text-status-running',
                            completed: 'bg-surface-3 text-text-secondary',
                            failed: 'bg-status-error/10 text-status-error',
                        }}
                    />
                </div>

                <div className="mt-6 p-4 bg-surface-3 rounded-lg">
                    <h3 className="font-medium mb-2">Raw Worker Data</h3>
                    <pre className="text-xs overflow-auto max-h-64 p-2 bg-surface-1 text-status-success rounded">
                        {JSON.stringify(worker, null, 2)}
                    </pre>
                </div>
            </div>
        </div>
    );
}
