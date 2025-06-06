export function DataCode() {
    const pythonCode = `"""
A LangGraph implementation for the testing agent.
"""
from fastapi import FastAPI
import uvicorn
from copilotkit.integrations.fastapi import add_fastapi_endpoint
from copilotkit import CopilotKitSDK, LangGraphAgent
import os
import uuid
import json
from typing import Dict, List, Any
from dotenv import load_dotenv

load_dotenv()

# LangGraph imports
from langchain_core.runnables import RunnableConfig
from langgraph.graph import StateGraph, END, START
from langgraph.types import Command, interrupt
from langgraph.checkpoint.memory import MemorySaver

# CopilotKit imports
from copilotkit import CopilotKitState
from copilotkit.langgraph import copilotkit_customize_config, copilotkit_emit_state, copilotkit_interrupt

# LLM imports
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage
from copilotkit.langgraph import (copilotkit_exit)

DEFINE_TEST_SCRIPT_TOOL = {
    "type": "function",
    "function": {
        "name": "generate_test_scripts",
        "description": "Make up 3 test scripts for a given task based on the context provided. The test scripts should be in the form of a list of steps.",
        "parameters": {
            "type": "object",
            "properties": {
                "testSuites": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "testId": { "type": "string" },
                            "prId": { "type": "string" },
                            "title": { "type": "string" },
                            "status": { "type": "string", "enum": ["passed", "failed", "yet_to_start"] },
                            "shortDescription": { "type": "string" },
                            "testCases": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "id": { "type": "string" },
                                        "name": { "type": "string" },
                                        "status": { "type": "string", "enum": ["passed", "failed", "yet_to_start", "pending"] },
                                        "executionTime": { "type": "string" },
                                        "createdAt": { "type": "string", "format": "date-time" },
                                        "updatedAt": { "type": "string", "format": "date-time" },
                                        "environment": { "type": "string" },
                                        "browser": { "type": "string" },
                                        "device": { "type": "string" },
                                        "testSteps": {
                                            "type": "array",
                                            "items": { "type": "string" }
                                        },
                                        "failureReason": { "type": "string" }
                                    },
                                    "required": [
                                        "id",
                                        "name",
                                        "status",
                                        "executionTime",
                                        "createdAt",
                                        "updatedAt",
                                        "environment",
                                        "testSteps",
                                    ]
                                }
                            },
                            "totalTestCases": { "type": "number" },
                            "passedTestCases": { "type": "number" },
                            "failedTestCases": { "type": "number" },
                            "skippedTestCases": { "type": "number" },
                            "coverage": { "type": "number" },
                            "createdAt": { "type": "string", "format": "date-time" },
                            "updatedAt": { "type": "string", "format": "date-time" },
                            "executedBy": { "type": "string" }
                        },
                        "required": [
                            "testId",
                            "prId",
                            "title",
                            "status",
                            "shortDescription",
                            "testCases",
                            "totalTestCases",
                            "passedTestCases",
                            "failedTestCases",
                            "skippedTestCases",
                            "coverage",
                            "createdAt",
                            "updatedAt",
                            "executedBy"
                        ]
                    }
                }
            },
            "required": ["testSuites"]
        }
    }
}

class AgentState(CopilotKitState):
    """
    The state of the agent.
    It inherits from CopilotKitState which provides the basic fields needed by CopilotKit.
    """
    testScripts: List[Dict[str, str]] = []

async def start_flow(state: Dict[str, Any], config: RunnableConfig):
    """
    This is the entry point for the flow.
    """
    # Initialize steps list if not exists
    if "testScripts" not in state:
        state["testScripts"] = []
    
    return Command(
        goto="chat_node",
        update={
            "messages": state["messages"],
            "testScripts": state["testScripts"],
        }
    )

async def chat_node(state: Dict[str, Any], config: RunnableConfig):
    """
    Standard chat node where the agent processes messages and generates responses.
    If task steps are defined, the user can enable/disable them using interrupts.
    """
    system_prompt = """
    You are a helpful assistant that can perform any task related to software testing and PR validation.
    You MUST call the \`generate_test_scripts\` function when the user asks you to perform a task.
    Once generated with the test scripts, provide a summary of it in maximum 5 sentences. Dont list the entire thing in detail. Also prompt user that you can add the script to your testing list.

    For every agent request, YOU MUST ALWAYS GENERATE 4 DIFFERENT TEST SUITES, each as a separate object in the array. Each test suite should be relevant to the context which is the CopilotKitReadables or PR provided by the user, and should have unique test cases and details. All the data which involves the user emails should be referred from the CopilotKitReadables.

    The test suite object you work with has the following structure (all fields are required unless marked optional):
    - testId: string
    - prId: string
    - title: string
    - status: 'passed' | 'failed' | 'yet_to_start'
    - shortDescription: string (a concise summary of what this test suite covers)
    - testCases: array of objects, each with:
        - id: string
        - name: string
        - status: 'passed' | 'failed' | 'yet_to_start' | 'pending'
        - executionTime: string
        - createdAt: string (date-time)
        - updatedAt: string (date-time)
        - environment: string
        - browser?: string
        - device?: string
        - testSteps: array of strings
        - failureReason?: string
    - totalTestCases: number
    - passedTestCases: number
    - failedTestCases: number
    - skippedTestCases: number
    - coverage: number
    - createdAt: string (date-time)
    - updatedAt: string (date-time)
    - executedBy: string

    When generating or reasoning about test scripts, always use this schema and ensure your output is relevant to the PR and test context provided by the user.
    """
    # Define the model
    model = ChatOpenAI(model="gpt-4o-mini")
    # Define config for the model
    if config is None:
        config = RunnableConfig(recursion_limit=25)
    
    # Use CopilotKit's custom config functions to properly set up streaming for the steps state
    config = copilotkit_customize_config(
        config,
        emit_intermediate_state=[{
            "state_key": "testScripts",
            "tool": "generate_test_scripts"
        }],
    )

    # Bind the tools to the model
    model_with_tools = model.bind_tools(
        [
            *state["copilotkit"]["actions"],
            DEFINE_TEST_SCRIPT_TOOL
        ],
        # Disable parallel tool calls to avoid race conditions
        parallel_tool_calls=False,
    )

    # Run the model and generate a response
    response = await model_with_tools.ainvoke([
        SystemMessage(content=system_prompt),
        *state["messages"],
    ], config)
    
    # Update messages with the response
    messages = state["messages"] + [response]
    
    # Handle tool calls
    if hasattr(response, "tool_calls") and response.tool_calls and len(response.tool_calls) > 0:
        tool_call = response.tool_calls[0]
        # Extract tool call information
        tool_call_id = ""
        if hasattr(tool_call, "id"):
            tool_call_id = tool_call.id
            tool_call_name = tool_call.name
            tool_call_args = tool_call.args if not isinstance(tool_call.args, str) else json.loads(tool_call.args)
        else:
            tool_call_id = tool_call.get("id", "")
            tool_call_name = tool_call.get("name", "")
            args = tool_call.get("args", {})
            tool_call_args = args if not isinstance(args, str) else json.loads(args)

        if tool_call_name == "generate_test_scripts":
            # Get the steps from the tool call
            state["testScripts"] = tool_call_args
            print(tool_call_args, "tool_call_args")
            tool_response = {
                "role": "tool",
                "content": "Test scripts generated. Allow user to select the test suites they want to run.",
                "tool_call_id": tool_call_id
            }
            messages = messages + [tool_response]
            await copilotkit_exit(config)
            return Command(
                goto=END,
                update={
                    "messages": messages,
                    "testScripts": state["testScripts"],
                }
            )
            
    # If no tool calls or not generate_task_steps, return to END with the updated messages
    await copilotkit_exit(config)
    return Command(
        goto=END,
        update={
            "messages": messages,
            "testScripts": state["testScripts"],
        }
    )

# Define the graph
workflow = StateGraph(AgentState)

# Add nodes
workflow.add_node("start_flow", start_flow)
workflow.add_node("chat_node", chat_node)

# Add edges
workflow.set_entry_point("start_flow")
workflow.add_edge(START, "start_flow")
workflow.add_edge("start_flow", "chat_node")
workflow.add_edge("chat_node", END)                 # Removed unconditional edge

# Compile the graph
testing_graph = workflow.compile(checkpointer=MemorySaver())

app = FastAPI()
sdk = CopilotKitSDK(
    agents=[
        LangGraphAgent(
            name="testing_agent",
            description="An example for a testing agent.",
            graph=testing_graph,
        )
    ]
)
add_fastapi_endpoint(app, sdk, "/copilotkit")

def main():
    """Run the uvicorn server."""
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "agent:app",
        host="0.0.0.0",
        port=port,
        reload=True,
    )

if __name__ == "__main__":
    main()`

    return (
        <div className="p-4 bg-white rounded-lg border border-gray-200 shadow-sm w-full">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-gray-800">Agent Code</h2>
                <span className="text-sm text-gray-500">Python</span>
            </div>
            <pre className="overflow-x-auto">
                <code className="text-sm text-gray-700 font-mono whitespace-pre-wrap break-words">
                    {pythonCode}
                </code>
            </pre>
        </div>
    )
}